import Foundation
import UIKit

/// Sends queued points to `POST ${serverUrl}/api/tracker/v1/positions` (API.md §3). Blocking; called only on the
/// engine queue (Android: Uploader.kt, same outcomes and backoff). Each call holds a UIKit background task so iOS
/// doesn't suspend the app mid-request.
final class Uploader {
  enum Outcome {
    /// Accepted (or queue empty / nothing to do).
    case done
    /// Network or any other server answer: nothing is dropped, try again at prefs.backoffUntil.
    case retry
    /// 401 REVOKED / INVALID (clearToken = true) or 403 INACTIVE: stop tracking.
    case stop(reason: String, clearToken: Bool)
  }

  private static let timeout: TimeInterval = 12
  private static let backoffBaseMs: Int64 = 5_000
  private static let backoffMaxMs: Int64 = 10 * 60_000
  private static let failuresWorthReporting = 3
  private static let maxBatchesPerRun = 400

  private let prefs: Prefs
  private let queue: PointQueue
  private let session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = Uploader.timeout
    c.timeoutIntervalForResource = Uploader.timeout * 2
    c.urlCache = nil
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: c)
  }()

  /// Phone health (Health.snapshot) sent with every batch; set by the Engine.
  var health: (() -> [String: Any])?
  var onConfig: (([String: Any]) -> Void)?
  var onRequired: ((Bool) -> Void)?
  var onAttention: ((_ id: String, _ title: String, _ text: String) -> Void)?
  var onRevoked: (() -> Void)?

  init(prefs: Prefs, queue: PointQueue) {
    self.prefs = prefs
    self.queue = queue
  }

  private struct Http {
    let code: Int
    let body: Data
  }

  private struct NetworkError: Error {
    let message: String
  }

  /// One blocking HTTP call, inside a background task.
  private func call(_ req: URLRequest) throws -> Http {
    let bg = BackgroundTask.begin("VeeTrax upload")
    defer { BackgroundTask.end(bg) }
    let done = DispatchSemaphore(value: 0)
    var result: Http?
    var failure: Error?
    let task = session.dataTask(with: req) { data, response, error in
      if let error = error {
        failure = error
      } else {
        result = Http(code: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data ?? Data())
      }
      done.signal()
    }
    task.resume()
    if done.wait(timeout: .now() + Uploader.timeout * 2 + 5) == .timedOut {
      task.cancel()
      throw NetworkError(message: "timed out")
    }
    if let failure = failure { throw failure }
    guard let r = result else { throw NetworkError(message: "no response") }
    return r
  }

  private func request(_ path: String, token: String) -> URLRequest? {
    guard let url = URL(string: "\(prefs.serverUrl)\(path)") else { return nil }
    var req = URLRequest(url: url)
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    return req
  }

  /// While tracking is off there are no uploads to carry the answer, so the watchdog asks. Nil when it can't tell.
  func fetchRequired(token: String) -> Bool? {
    guard var req = request("/api/tracker/v1/me", token: token) else { return nil }
    req.httpMethod = "GET"
    guard let res = try? call(req), (200...299).contains(res.code),
      let json = (try? JSONSerialization.jsonObject(with: res.body)) as? [String: Any],
      let required = json["required"] as? NSNumber
    else { return nil }
    return required.boolValue
  }

  /// Uploads the queue oldest first in batches of config.batchMax until it is empty or a call fails.
  func drain() -> Outcome {
    guard let token = prefs.token else { return .done }
    for _ in 0..<Uploader.maxBatchesPerRun {
      let batch = queue.peek(prefs.config.batchMax)
      if batch.isEmpty {
        if prefs.revokedDraining { return .stop(reason: "REVOKED", clearToken: true) }
        // No points, but the server should still hear about a stop or restart (the health report carries them).
        return prefs.hasPendingEvents() ? send(token: token, batch: batch) : .done
      }
      let o = send(token: token, batch: batch)
      guard case .done = o else { return o }
      queue.remove(batch.map { $0.t })
    }
    return .done
  }

  /// Sends one batch and updates status / backoff. Done = the server has it, the caller removes it from the queue.
  func send(token: String, batch: [Point]) -> Outcome {
    var payload: [String: Any] = ["positions": batch.map { $0.toJSON() }]
    let healthReport = health?()
    if let h = healthReport { payload["health"] = h }
    guard var req = request("/api/tracker/v1/positions", token: token),
      let body = try? JSONSerialization.data(withJSONObject: payload)
    else { return backoff("Upload failed: bad request") }
    req.httpMethod = "POST"
    req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
    req.httpBody = body

    let res: Http
    do {
      res = try call(req)
    } catch let e as NetworkError {
      return backoff("Network error: \(e.message)")
    } catch {
      return backoff("Network error: \(error.localizedDescription)")
    }
    let json = (try? JSONSerialization.jsonObject(with: res.body)) as? [String: Any]
    let code = (json?["code"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let message = json.flatMap(messageOf) ?? "HTTP \(res.code)"

    switch res.code {
    case 200...299:
      prefs.ackEvents((healthReport?["events"] as? [Any])?.count ?? 0)
      if prefs.failures >= Uploader.failuresWorthReporting {
        prefs.recordEvent("upload", "worked after \(prefs.failures) failures: \(prefs.lastError ?? "unknown error")")
      }
      prefs.lastUploadAt = nowMs()
      prefs.lastError = nil
      prefs.failures = 0
      prefs.backoffUntil = 0
      if let cfg = json?["config"] as? [String: Any] { onConfig?(cfg) }
      if let required = json?["required"] as? NSNumber { onRequired?(required.boolValue) }
      if (json?["revoked"] as? NSNumber)?.boolValue == true { onRevoked?() }
      if let a = json?["attention"] as? [String: Any], let id = a["id"] as? String, !id.isEmpty {
        onAttention?(id, a["title"] as? String ?? "", a["text"] as? String ?? "")
      }
      return .done
    case 401:
      return .stop(reason: code == "REVOKED" ? "REVOKED" : "INVALID", clearToken: true)
    case 403 where code == "INACTIVE":
      return .stop(reason: "INACTIVE", clearToken: false)
    case 408, 429, 500...:
      return backoff("Server: \(message)")
    default:
      // Any other answer is kept and retried too: a proxy or a server bug must never cost points.
      return backoff("Rejected: \(message)")
    }
  }

  private func messageOf(_ o: [String: Any]) -> String? {
    if let s = o["message"] as? String { return s }
    if let a = o["message"] as? [Any] { return a.map { "\($0)" }.joined(separator: ", ") }
    return nil
  }

  private func backoff(_ error: String) -> Outcome {
    let failures = prefs.failures + 1
    let delay = min(Uploader.backoffMaxMs, Uploader.backoffBaseMs << Int64(min(failures - 1, 10)))
    prefs.failures = failures
    prefs.backoffUntil = nowMs() + delay
    prefs.lastError = error
    return .retry
  }
}

/// UIKit background task around work that must finish if the app leaves the screen (begin / end are thread-safe).
/// Ended exactly once: by the caller, or by the expiration handler (iOS kills an app that lets a task expire).
final class BackgroundTask {
  private let lock = NSLock()
  private var id: UIBackgroundTaskIdentifier = .invalid

  static func begin(_ name: String) -> BackgroundTask {
    let task = BackgroundTask()
    let id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak task] in task?.finish() }
    task.lock.lock()
    task.id = id
    task.lock.unlock()
    return task
  }

  static func end(_ task: BackgroundTask) { task.finish() }

  private func finish() {
    lock.lock()
    let current = id
    id = .invalid
    lock.unlock()
    if current != .invalid { UIApplication.shared.endBackgroundTask(current) }
  }
}
