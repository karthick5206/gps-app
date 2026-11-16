import CoreLocation
import Foundation
import UIKit

struct BatteryInfo {
  var level: Int?
  var charging: Bool?
}

/// Battery % and charging. UIDevice is main-thread only: read in the location callbacks (main) and passed along.
enum Battery {
  static func read() -> BatteryInfo {
    let device = UIDevice.current
    if !device.isBatteryMonitoringEnabled { device.isBatteryMonitoringEnabled = true }
    let level: Int? = device.batteryLevel >= 0 ? Int((device.batteryLevel * 100).rounded()) : nil
    var charging: Bool?
    switch device.batteryState {
    case .charging, .full: charging = true
    case .unplugged: charging = false
    default: charging = nil
    }
    return BatteryInfo(level: level, charging: charging)
  }
}

/// One queued position, exactly the API.md upload format (same fields as Android's Point.kt).
struct Point {
  var t: Int64
  var lat: Double
  var lng: Double
  var acc: Double?
  var spd: Double?
  var brg: Double?
  var alt: Double?
  var bat: Int?
  var chg: Bool?
  var mock: Bool
  var sos: Bool = false
  /// The filter's verdict when it doubts this fix (inaccurate / jump / mock / still); the server decides.
  var flt: String?
  var prov: String?
  var sacc: Double?
  var sat: Int?
  var mode: String?

  private static func round1(_ v: Double) -> Double { (v * 10).rounded() / 10 }

  func toJSON() -> [String: Any] {
    func orNull(_ v: Any?) -> Any { v ?? NSNull() }
    var o: [String: Any] = [
      "t": NSNumber(value: t),
      "lat": lat,
      "lng": lng,
      "acc": orNull(acc.map(Point.round1)),
      "spd": orNull(spd.map(Point.round1)),
      "brg": orNull(brg.map(Point.round1)),
      "alt": orNull(alt.map(Point.round1)),
      "bat": orNull(bat),
      "chg": orNull(chg),
      "mock": mock,
      "sos": sos,
    ]
    if let flt = flt { o["flt"] = flt }
    if let prov = prov { o["prov"] = prov }
    if let sacc = sacc { o["sacc"] = Point.round1(sacc) }
    if let sat = sat { o["sat"] = sat }
    if let mode = mode { o["mode"] = mode }
    return o
  }

  func jsonString() -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: toJSON()) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func fromJSON(_ s: String) -> Point? {
    guard let data = s.data(using: .utf8),
      let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let t = (o["t"] as? NSNumber)?.int64Value,
      let lat = (o["lat"] as? NSNumber)?.doubleValue,
      let lng = (o["lng"] as? NSNumber)?.doubleValue
    else { return nil }
    func dbl(_ k: String) -> Double? { (o[k] as? NSNumber)?.doubleValue }
    func str(_ k: String) -> String? { (o[k] as? String).flatMap { $0.isEmpty ? nil : $0 } }
    return Point(
      t: t, lat: lat, lng: lng,
      acc: dbl("acc"), spd: dbl("spd"), brg: dbl("brg"), alt: dbl("alt"),
      bat: (o["bat"] as? NSNumber)?.intValue,
      chg: (o["chg"] as? NSNumber)?.boolValue,
      mock: (o["mock"] as? NSNumber)?.boolValue ?? false,
      sos: (o["sos"] as? NSNumber)?.boolValue ?? false,
      flt: str("flt"), prov: str("prov"), sacc: dbl("sacc"),
      sat: (o["sat"] as? NSNumber)?.intValue,
      mode: str("mode")
    )
  }

  /// iOS 15+: a location from a simulator or a developer tool (Xcode GPX, external accessory spoofing).
  static func isMock(_ loc: CLLocation) -> Bool {
    if #available(iOS 15.0, *) {
      return loc.sourceInformation?.isSimulatedBySoftware ?? false
    }
    return false
  }

  static func from(_ loc: CLLocation, battery: BatteryInfo, sos: Bool = false, mode: String? = nil) -> Point {
    Point(
      t: Int64((loc.timestamp.timeIntervalSince1970 * 1000).rounded()),
      lat: loc.coordinate.latitude,
      lng: loc.coordinate.longitude,
      acc: loc.horizontalAccuracy >= 0 ? loc.horizontalAccuracy : nil,
      spd: loc.speed >= 0 ? loc.speed : nil,
      brg: loc.course >= 0 ? loc.course : nil,
      alt: loc.verticalAccuracy > 0 ? loc.altitude : nil,
      bat: battery.level,
      chg: battery.charging,
      mock: isMock(loc),
      sos: sos,
      prov: nil,
      sacc: loc.speedAccuracy >= 0 ? loc.speedAccuracy : nil,
      sat: nil,
      mode: mode
    )
  }
}
