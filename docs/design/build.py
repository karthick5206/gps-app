#!/usr/bin/env python3
"""Builds the VeeTracer design document (HTML) and prints it to PDF with headless Chrome.

Usage:  python3 docs/design/build.py
Output: docs/VeeTracer_Design_Document_v1.0.pdf (+ docs/design/VeeTracer_Design_Document.html)
"""
import html
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
OUT_HTML = ROOT / "VeeTracer_Design_Document.html"
OUT_PDF = ROOT.parent / "VeeTracer_Design_Document_v2.0.pdf"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

VERSION = "2.0 (Approved)"
DATE = "18 October 2026"

parts = []
toc = []
counter = {"h1": 0, "h2": 0}


def h1(title):
    counter["h1"] += 1
    counter["h2"] = 0
    n = counter["h1"]
    toc.append((n, title))
    parts.append(f'<h1 id="s{n}"><span class="num">{n}</span>{title}</h1>')


def h2(title):
    counter["h2"] += 1
    parts.append(f'<h2>{counter["h1"]}.{counter["h2"]} {title}</h2>')


def h3(title):
    parts.append(f"<h3>{title}</h3>")


def p(text):
    parts.append(f"<p>{text}</p>")


def ul(items):
    parts.append("<ul>" + "".join(f"<li>{i}</li>" for i in items) + "</ul>")


def note(text, kind="info"):
    parts.append(f'<div class="callout {kind}">{text}</div>')


def table(headers, rows, cls=""):
    th = "".join(f"<th>{h}</th>" for h in headers)
    trs = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    parts.append(f'<table class="{cls}"><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>')


def badge(ph):
    return f'<span class="ph ph{ph[-1]}">{ph}</span>'


FEATURE_COUNT = {"n": 0, "modules": set()}


def features(prefix, rows):
    """rows: list of (feature_text, phase)."""
    FEATURE_COUNT["modules"].add(prefix)
    out = []
    for i, (text, ph) in enumerate(rows, 1):
        FEATURE_COUNT["n"] += 1
        out.append((f'<span class="fid">{prefix}-{i:02d}</span>', text, badge(ph)))
    table(["ID", "Feature", "Phase"], out, "feat")


def raw(s):
    parts.append(s)


# ---------------------------------------------------------------------------
# 1. Introduction
# ---------------------------------------------------------------------------
h1("About this document")
p("This document describes <b>VeeTracer</b>, a multi-tenant GPS tracking SaaS platform for the Indian market, "
  "covering the web dashboard, the VeeTracer mobile app and the VeeTracer Parent app. It consolidates every "
  "requirement agreed during the discovery discussions and turns them into a product scope, a system design, "
  "a data model and a phased roadmap.")
p("<b>Status:</b> <b>Approved</b> on 18 October 2026 as the baseline for development. Any change after approval "
  "is recorded as a new version in the change table below.")
h2("How to read and request changes")
ul([
    "Every feature has a unique ID (for example <b>MAP-07</b>, <b>ALR-12</b>). Refer to IDs when asking for changes.",
    "Every feature has a phase: " + badge("P1") + " core launch, " + badge("P2") + " operations, "
    + badge("P3") + " video &amp; advanced, " + badge("P4") + " growth. Later-phase features are still "
    "accounted for in the data model from day one, so adding them later needs no rework.",
    "Section <!--OPEN_SEC--> lists the decisions that are still open. Those need an answer before or during Phase 1.",
])
h2("Changes in this version")
table(["Version", "Change"], [
    ["2.0", "<b>Approved baseline.</b> Added the milestone delivery plan (section on phased roadmap). Feature scope unchanged from 1.7."],
    ["1.7", "Web UI built with Tailwind CSS (+ shadcn/ui components); light, dark and system themes across web, mobile apps and maps; "
            "shared design tokens (module UI, section 11.2)."],
    ["1.6", "App line-up: separate VeeTracer Admin app; one role-based VeeTracer app for drivers, employees, users, individuals and delivery staff; "
            "Driver and Employee experiences; animations and trip playback across web and mobile (new section 11; modules APP, DRA, EMA, ANI)."],
    ["1.5", "Template Master page listing all templates (TPL-16 to TPL-21, section 9.5). New section 10: Master pages — "
            "a standard list/view/edit page for every master, the complete master catalogue and lookup masters (module MST)."],
    ["1.4", "Viewable and editable message templates (email, SMS, WhatsApp, push) with placeholders, preview, test send, "
            "versions, and the DLT/Meta approval workflow (module TPL, section 9.5)."],
    ["1.3", "Recipient management per alert: email, SMS, WhatsApp and push lists; company default lists; "
            "use default / default + extra / replace; external contacts; test send; delivery log (ALM-28 to ALM-38, section 9.4)."],
    ["1.2", "Configurable overspeed and long-idling alerts: thresholds, durations, tolerance, severity tiers, "
            "time/zone-based limits, repeat behaviour, exclusions (features ALM-18 to ALM-27, section 9.3)."],
    ["1.1", "Added Alert management (group level and individual level): configuration levels with inheritance and overrides, "
            "alert templates, user subscriptions, contact groups, snooze/maintenance mode, alert handling workflow and analytics "
            "(module ALM, section 9)."],
    ["1.0", "First complete draft."],
])
h2("Document contents")
raw("<!--TOC-->")

# ---------------------------------------------------------------------------
h1("Executive summary")
p("VeeTracer lets businesses and individuals track anything that moves — vehicles, people, delivery staff, "
  "students' buses, assets, pets — on a live map, receive configurable alerts within seconds, replay history, "
  "manage drivers, routes and trips, monitor fuel and driving behaviour, and (later) watch live camera feeds. "
  "It is sold directly to customers on fixed monthly or annual plans in INR, and can be white-labelled and resold by partners.")
h2("Key decisions")
table(["Area", "Decision"], [
    ["Market", "India first. INR pricing, GST invoicing, Razorpay, DLT-registered SMS, AIS-140 support."],
    ["Sales model", "Direct to customers (Business and Individual accounts). White-label partners later (P4)."],
    ["Scale target", "~2,000 devices in year one; architecture designed and load-tested for <b>10,000+</b>."],
    ["Top priority", "Performance of <b>live tracking and alerts</b>: device → map under 2 s, alert → app under 2 s."],
    ["Devices", "Mostly Concox (GT06 family); other brands, OBD, GPS watches, pet trackers, phones, AIS-140, dashcams/MDVR."],
    ["Configuration", "Everything (alerts, map fields, reports, commands) driven by the <b>device model's capabilities</b>."],
    ["Objects vs devices", "A vehicle/person/pet is permanent; the device fitted to it can be swapped without losing history."],
    ["Platform owner", "Exactly <b>one Super Admin</b> (VeeTracer) who sees and controls every customer."],
    ["Organisation", "Company → Branch → Vehicles; roles Admin → Manager → User; menu-level View/Create/Edit/Delete."],
    ["Data retention", "Per customer, 30–180 days (6 months max), automatic deletion; no data loss under load."],
    ["Maps", "OpenStreetMap data hosted locally: own tiles, address lookup and routing."],
    ["Technology", "Open source first: NestJS, PostgreSQL + TimescaleDB, Valkey, React, Flutter, ZLMediaKit."],
    ["Hosting", "Own server or any cloud, packaged with Docker."],
])
h2("Applications")
table(["Application", "Platform", "Used by"], [
    ["VeeTracer Web", "Browser (desktop, tablet)", "Super Admin, partners, all company roles, individuals — full management"],
    ["VeeTracer Admin (mobile)", "Android, iOS (Flutter)", "Company Admins and Managers (and Super Admin) — fleet management on the go"],
    ["VeeTracer (mobile, role-based)", "Android, iOS (Flutter)", "Drivers, attendants, employees (passengers), users/viewers, individuals, delivery staff — menus change by role"],
    ["VeeTracer Parent", "Android, iOS (Flutter)", "Parents only — their own children's bus and trips"],
    ["Public API &amp; webhooks", "REST / WebSocket", "Customers' and partners' own systems"],
])

# ---------------------------------------------------------------------------
h1("Product scope")
h2("What can be tracked")
table(["Object type", "Typical device", "Typical customer"], [
    ["Vehicle (car, bike, truck, bus, van)", "Concox GT06 family, Teltonika, OBD, AIS-140, dashcam/MDVR", "Fleets, logistics, schools, rentals, individuals"],
    ["Person / employee", "VeeTracer app on phone, GPS watch", "Field staff, security, elderly care"],
    ["Delivery person", "VeeTracer app on phone (tracker mode)", "Delivery and courier businesses"],
    ["Student (via the bus)", "Bus tracker + RFID reader (optional)", "Schools"],
    ["Asset", "Battery tracker (GPS + cell tower/Wi-Fi)", "Equipment, containers, generators"],
    ["Pet", "Pet tracker", "Individuals"],
])
h2("Account types")
table(["Capability", "Business account", "Individual account"], [
    ["Live map, history, alerts, geofences", "Full", "Full (simplified screens)"],
    ["Automatic trips", "Yes", "Yes (\"My rides\")"],
    ["Branches, roles, managers", "Yes", "No — single owner, can invite family as viewers"],
    ["Drivers, licences, Driver → Vehicle → Route → Trip", "Yes", "No — the owner rides their own vehicles"],
    ["Passenger module (students / employees)", "Yes (module switch)", "No"],
    ["Fuel, driver score, maintenance", "Yes", "Basic (service &amp; insurance reminders)"],
    ["Home screen", "Fleet dashboard", "\"My Vehicles\""],
])
p("The account type is chosen at signup and controls menus and available plans. An Individual account can be "
  "upgraded to Business at any time without losing data.")
h2("Who uses the platform")
table(["Level", "Role", "Sees"], [
    ["Platform", "<b>Super Admin</b> (exactly one — VeeTracer)", "Everything: all partners, companies, users, devices, billing, settings"],
    ["Partner (P4)", "Partner Admin", "Only its own customers (white-label reseller)"],
    ["Company", "Admin", "Whole company"],
    ["Company", "Manager", "Assigned branches and own team"],
    ["Company", "User / Viewer", "Assigned branches and/or individual vehicles"],
    ["Company", "Driver / Attendant", "Own duty, own vehicle, trip, attendance marking"],
    ["Company", "Passenger (Employee)", "Own cab only (\"Track my cab\")"],
    ["Company", "Parent (Parent app)", "Own children's details, bus and trips only"],
])

# ---------------------------------------------------------------------------
h1("Organisation, roles and access")
h2("Hierarchy")
raw("""
<div class="tree">
<div class="node root">VeeTracer Super Admin <small>(one account)</small></div>
<div class="branch">
  <div class="node">Partner <small>white-label, P4 — direct customers sit under the "VeeTracer" partner</small></div>
  <div class="branch">
    <div class="node">Company <small>Business or Individual account</small></div>
    <div class="branch">
      <div class="node">Branch <small>flat, one level (e.g. Chennai, Coimbatore)</small></div>
      <div class="branch">
        <div class="node leaf">Vehicles / Persons / Assets / Pets &nbsp;·&nbsp; Drivers &nbsp;·&nbsp; Routes → Trips &nbsp;·&nbsp; Passengers</div>
      </div>
    </div>
  </div>
</div>
</div>
""")
h2("Two independent access controls")
table(["Control", "Question it answers", "Configured by"], [
    ["<b>Permissions</b> (role → menu → action)", "What can this user <i>do</i>?", "Roles, menu-role mapping, user-role mapping"],
    ["<b>Data scope</b> (branches + individual objects)", "Which objects can this user <i>see</i>?", "User → branch mapping, user → object mapping"],
])
ul([
    "A vehicle belongs to <b>exactly one branch</b>.",
    "A user can be mapped to one or more branches <b>and</b> to individual objects. Example: one user sees their bike and their car on their own dashboard even if they sit in different branches.",
    "Saved <b>vehicle groups</b> (e.g. \"Night shift trucks\") are only for filtering and reports; they never grant visibility.",
    "Every API call, live update, report, export and webhook applies both controls on the server side.",
])
h2("Default permission matrix")
p("Actions per menu: <b>V</b> view, <b>C</b> create, <b>E</b> edit, <b>D</b> delete, plus special actions "
  "(Export, Send command, View live video, Download video). Companies can create custom roles.")
table(["Menu", "Admin", "Manager", "User", "Viewer"], [
    ["Dashboard / Live map", "V", "V", "V", "V"],
    ["Vehicles &amp; objects", "V C E D", "V E", "V", "V"],
    ["Devices &amp; SIMs", "V C E D", "V", "—", "—"],
    ["Drivers", "V C E D", "V C E", "V", "—"],
    ["Routes &amp; trips", "V C E D", "V C E", "V", "V"],
    ["Passengers", "V C E D", "V C E", "V", "—"],
    ["Geofences &amp; POIs", "V C E D", "V C E", "V", "V"],
    ["Alert rules", "V C E D", "V C E", "—", "—"],
    ["Alerts", "V + acknowledge", "V + acknowledge", "V + acknowledge", "V"],
    ["Commands (engine cut-off etc.)", "Send", "Send", "—", "—"],
    ["Live video / playback / download", "All", "View, playback", "—", "—"],
    ["Reports &amp; scheduled reports", "V + Export + schedule", "V + Export + schedule", "V", "V"],
    ["Users &amp; roles", "V C E D", "V C (own team)", "—", "—"],
    ["Message templates", "V E", "V", "—", "—"],
    ["Company settings, billing", "V E (Owner pays)", "—", "—", "—"],
])
h2("Single Super Admin")
ul([
    "Exactly one Super Admin account exists. The system refuses to create a second one.",
    "Mandatory two-factor login. All Super Admin actions are written to the audit log.",
    "A documented server-level recovery procedure covers loss of the password or second factor.",
    "Super Admin can view any customer account (\"view as\") for support; every such session is logged.",
])

# ---------------------------------------------------------------------------
h1("Complete feature list")
p("All features agreed so far, grouped by module. The count is computed automatically at the end of this section.")

h2("Platform, accounts and white-label")
features("PLT", [
    ("Hierarchy Super Admin → Partner → Company → Branch → Objects (partner level enabled in P4)", "P1"),
    ("Complete data isolation between partners and companies", "P1"),
    ("Company profile: logo, address, GSTIN, timezone, units (km/mi, L/gal), language", "P1"),
    ("Account types Business and Individual, each with its own menus, plans and home screen", "P1"),
    ("Upgrade Individual → Business without losing data", "P1"),
    ("Customer self-signup and device activation by entering or scanning the IMEI", "P1"),
    ("Module switches per company (e.g. Passenger module, Video, Fuel) controlled by Super Admin and plan", "P1"),
])
features("WL", [
    ("Partner custom domain, logo, colours, favicon and login page", "P4"),
    ("Partner-branded email/SMS templates and sender identity", "P4"),
    ("Partner-branded mobile and parent apps (separate store builds from one codebase)", "P4"),
    ("Partner admin panel: own customers, devices, plans, prices", "P4"),
    ("Partner plans on top of VeeTracer wholesale price per device", "P4"),
    ("Two-level billing: VeeTracer invoices partner, partner invoices customers", "P4"),
    ("Optional \"Powered by VeeTracer\"", "P4"),
])

h2("Login and security")
features("AUTH", [
    ("Login with mobile number + OTP, or email + password", "P1"),
    ("OTP: 6 digits, 5-minute validity, resend after 30 s, max 5 attempts, SMS (DLT) or WhatsApp", "P1"),
    ("Password reset by email: single-use link valid 30 minutes; all sessions signed out after reset", "P1"),
    ("Password policy and temporary lockout after repeated failures", "P1"),
    ("Parent app: mobile + OTP only, matched to guardian phone in student profile", "P1"),
    ("Two-factor login (mandatory for Super Admin, optional for others)", "P1"),
    ("Trusted devices, active-session list and remote sign-out", "P2"),
    ("Biometric unlock in mobile apps", "P2"),
])
features("SEC", [
    ("Audit log of every create/update/delete, command, video view and login", "P1"),
    ("HTTPS/TLS everywhere; encrypted backups and encrypted sensitive documents", "P1"),
    ("DPDP Act 2023: consent records for person tracking, data export and deletion on request", "P1"),
    ("Aadhaar: only last 4 digits shown, document stored encrypted", "P1"),
    ("Rate limiting and abuse protection on login, OTP, API and ingestion", "P1"),
])

h2("Organisation, users and roles")
features("ORG", [
    ("Branches (single level) under a company; each vehicle in exactly one branch", "P1"),
    ("Hierarchy Admin → Manager → User; managers manage only their own team and branches", "P1"),
    ("User → branch mapping and user → individual vehicle mapping", "P1"),
    ("Built-in roles plus custom roles per company", "P1"),
    ("Menu-role mapping with View/Create/Edit/Delete and special actions", "P1"),
    ("Menus on web and mobile shown or hidden from permissions", "P1"),
    ("Limited roles: Driver, Attendant, Passenger (Employee), Parent", "P1"),
    ("Saved vehicle groups for filters and reports (no effect on visibility)", "P1"),
    ("Super Admin \"view as customer\" with audit trail", "P2"),
])

h2("Devices and tracked objects")
features("DEV", [
    ("Object types: Vehicle, Person, Delivery person, Asset, Pet, Watch wearer", "P1"),
    ("Object separated from device; device swap keeps history, rules, odometer and engine hours", "P1"),
    ("Device assignment history (which device on which object, from–to)", "P1"),
    ("Device model catalogue: brand, model, protocol, capabilities, extra fields, commands, time offset", "P1"),
    ("Capability-driven UI: alerts, map popup, reports and commands show only what the model supports (e.g. AC on/off)", "P1"),
    ("When a swapped-in device lacks a capability, dependent rules pause and are flagged (not deleted)", "P1"),
    ("Common fields + model-specific extra fields + company custom fields", "P1"),
    ("Object fields per type (vehicle: plate, make, fuel type; person: phone, employee ID; pet: breed, vet)", "P1"),
    ("Custom icons and colours per object", "P1"),
    ("Device &amp; SIM stock: IMEI, SIM number, operator, expiry, assigned customer", "P1"),
    ("Device health: last seen, GSM signal, battery, firmware, data usage", "P2"),
    ("Bulk import of devices and objects from Excel", "P2"),
])

h2("Device protocols and hardware support")
features("PRO", [
    ("Concox GT06 family (own decoder): login, GPS, LBS, status, alarm, heartbeat, commands", "P1"),
    ("VeeTracer app phone tracking; Traccar Client / OsmAnd HTTP protocol", "P1"),
    ("Normalisation of vendor codes into standard fields (e.g. Teltonika IO 239 → ignition)", "P1"),
    ("AIS-140 VLTD: packet decoder, emergency/panic handling, certificate records, government server forwarding", "P2"),
    ("Teltonika Codec 8 / 8E", "P2"),
    ("Other brands via Traccar gateway (Queclink, Meitrack, Coban, Sinotrack, Ruptela, 200+)", "P2"),
    ("OBD devices: RPM, coolant temp, fuel %, engine load, battery voltage, fault codes (DTC), VIN, odometer", "P2"),
    ("GPS watches: SOS, fall, heart rate, steps, watch removed, Wi-Fi/LBS location", "P2"),
    ("Pet trackers: safe zone, lost mode, battery-saving schedules", "P2"),
    ("Cell-tower and Wi-Fi location lookup (OpenCelliD + local Wi-Fi database)", "P2"),
    ("JT/T 808 dashcams and MDVRs (positions, alarms, ADAS/DMS events)", "P3"),
])

h2("Live tracking and map")
features("MAP", [
    ("Live map with device → screen latency under 2 seconds", "P1"),
    ("Movement status colours: Running, Idle, Off, Overspeeding, Offline; thresholds per company", "P1"),
    ("View modes: all, by branch, by vehicle group, by status, by type, multiple selected, single vehicle (follow)", "P1"),
    ("Search by name, plate, IMEI, driver name or phone", "P1"),
    ("Vehicle list: status colour, speed, time in status, last update, driver, ignition/battery/GPS icons, status-count filter chips", "P1"),
    ("Marker clustering, direction arrows, plate labels, smooth marker animation", "P1"),
    ("Only objects in the visible area and within the user's scope are streamed", "P1"),
    ("Auto-fit map to selection; follow mode", "P1"),
    ("Vehicle info panel with tabs: Overview, Device, Sensors, Driver, Trip, Alerts, Documents, Camera", "P1"),
    ("Quick actions: follow, playback, today's trips, share link, command, video, geofence here, nearest vehicles, report", "P1"),
    ("Multi-screen tracking: 2, 4 or 6 maps following different vehicles", "P2"),
    ("Saved map views (filters + area)", "P2"),
    ("Live location share link with expiry", "P2"),
    ("Nearest vehicle to a point; distance and ETA (OSRM)", "P2"),
    ("Map tools: address search, distance measure, draw geofence", "P1"),
    ("Layers: geofences, POIs, route lines, alert markers, labels", "P1"),
    ("Satellite layer (optional, needs a paid imagery provider)", "P4"),
])
h3("Movement status rules (defaults, configurable per company)")
table(["Status", "Colour", "Rule"], [
    ['Running', '<span class="dot" style="background:#16a34a"></span> Green', "Speed &gt; 5 km/h"],
    ['Idle', '<span class="dot" style="background:#f59e0b"></span> Amber', "Ignition on, not moving for &gt; 2 min"],
    ['Off / Stopped', '<span class="dot" style="background:#dc2626"></span> Red', "Ignition off, or stationary when the device has no ignition input"],
    ['Overspeeding', '<span class="dot" style="background:#9333ea"></span> Purple', "Speed above the object's (or zone's) limit"],
    ['Offline', '<span class="dot" style="background:#9ca3af"></span> Grey', "No data for &gt; 10 min"],
])

h2("History and playback")
features("HIS", [
    ("Route playback 1×–16× with timeline scrubber and speed graph", "P1"),
    ("Stops, idle points and parking durations on the route", "P1"),
    ("Automatic trip list (from ignition/movement): start/end, distance, duration, max/avg speed", "P1"),
    ("Alerts shown on the playback timeline", "P1"),
    ("History continuous across device swaps", "P1"),
    ("Snap route to roads (OSRM)", "P2"),
    ("Planned route overlaid on actual path for route trips", "P1"),
    ("Video synced with playback", "P3"),
])

h2("Alerts and notifications")
features("ALR", [
    ("Rules engine: scope (objects/branch/group/model), conditions, thresholds, schedule, cooldown, recipients, channels", "P1"),
    ("Alert types offered only if the device model supports them", "P1"),
    ("Latency targets: in-app under 2 s, push under 5 s", "P1"),
    ("Channels: in-app, push (FCM), email", "P1"),
    ("Channels: SMS (DLT), WhatsApp, webhook", "P2"),
    ("Live alert panel beside the map with sound, priority colours, filters, unread count", "P1"),
    ("Click alert → zoom to location and open the object; acknowledge/comment in place", "P1"),
    ("Critical alerts (SOS, fuel theft, crash, student not dropped) stay on screen until acknowledged", "P1"),
    ("Alert markers on the map", "P1"),
    ("Acknowledge, comment, resolve; full alert history", "P1"),
    ("Escalation if unacknowledged after X minutes", "P2"),
    ("Per-user notification preferences and quiet hours", "P2"),
    ("Plan controls which channels are available (e.g. SMS/WhatsApp only on paid plans)", "P1"),
])
h3("Alert catalogue")
table(["Category", "Alerts", "Requires capability", "Phase"], [
    ["Driving", "Overspeed, idling, after-hours use, unauthorised movement", "GPS (+ ignition for idling)", badge("P1")],
    ["Driving", "Harsh braking / acceleration / cornering, towing", "Accelerometer events or 1 s data", badge("P2")],
    ["Location", "Geofence enter/exit, stayed too long, zone speed limit, no-go, keep-inside", "GPS", badge("P1")],
    ["Location", "Route deviation, POI arrival", "GPS + route", badge("P2")],
    ["Device", "Power cut, low battery, offline, GPS lost, tamper", "Per model", badge("P1")],
    ["Device", "SIM change", "Per model", badge("P2")],
    ["Vehicle", "Ignition on/off, AC on/off", "Ignition / AC input", badge("P1")],
    ["Vehicle", "Door, temperature, engine fault (DTC)", "Sensor / OBD", badge("P2")],
    ["Fuel", "Fuel theft/drain, refuel, low fuel", "Fuel sensor or OBD", badge("P2")],
    ["Safety", "SOS / panic", "SOS button", badge("P1")],
    ["Safety", "Crash, fall, watch removed", "Per model", badge("P2")],
    ["Trips", "Trip not started, late at stop, skipped stop, unscheduled stop, long halt, trip completed", "Route trips", badge("P1")],
    ["Passengers", "Student not dropped, wrong bus, absent, night-drop rules", "Passenger module", badge("P2")],
    ["Maintenance", "Service due, document expiry, licence/badge expiry", "—", badge("P2")],
    ["Dashcam AI", "Drowsiness, distraction, phone use, smoking, forward collision, lane departure", "ADAS/DMS camera", badge("P3")],
])

h2("Alert management (group and individual level)")
features("ALM", [
    ("Alert settings at four levels: Company default → Branch → Vehicle group → Individual vehicle/person", "P1"),
    ("Most specific level wins, per alert type and per setting (on/off, threshold, schedule, channels, recipients, priority, cooldown)", "P1"),
    ("Every setting shows where it comes from (e.g. \"inherited from Branch: Chennai\") with one-click \"reset to inherited\"", "P1"),
    ("Individual override: different threshold or recipients for one vehicle, or switch an alert off for that vehicle only", "P1"),
    ("Vehicle in several groups: admin sets group priority; conflicts are shown in the UI before saving", "P1"),
    ("Only alert types the object's device supports are shown at individual level; group level shows the union with a 'supported by N of M' count", "P1"),
    ("Alert templates (e.g. School bus pack, Truck pack, Two-wheeler pack, Pet pack) applied to a group or selected objects in one step", "P1"),
    ("Copy alert settings from one vehicle to other vehicles or groups", "P1"),
    ("Bulk enable/disable an alert type across a branch or group", "P1"),
    ("Snooze / maintenance mode: mute all or chosen alerts for an object or group until a date/time (e.g. vehicle in workshop); auto-resume", "P1"),
    ("Mandatory alerts (SOS, panic, crash, student not dropped) cannot be switched off below company level", "P1"),
    ("User subscriptions: each user chooses which alert types, vehicles/groups and channels they receive, within what the admin allows", "P1"),
    ("Contact groups for recipients, including people without a login (e.g. customer contact, security desk) — email/SMS/WhatsApp only", "P2"),
    ("Alert handling workflow: New → Acknowledged → In progress → Resolved / False alarm, with assignee, notes and resolution time", "P2"),
    ("Assign an alert to a user; escalation chain per level (user → manager → admin)", "P2"),
    ("Alert analytics: counts by type, group, vehicle, driver; response and resolution times; noisiest vehicles and rules", "P2"),
    ("Change history of alert settings (who changed what, at which level)", "P1"),
    ("Overspeed: speed limit per level (company, branch, group, vehicle) with vehicle-type defaults", "P1"),
    ("Overspeed: tolerance, minimum duration before alerting, Warning/Critical tiers", "P1"),
    ("Overspeed: time-based limits (e.g. lower limit at night) and zone limits inside geofences", "P1"),
    ("Overspeed: one alert per event, optional repeat while it continues, end-of-event summary (max speed, duration, distance)", "P1"),
    ("Overspeed: road speed limits from OSM maxspeed data where available", "P4"),
    ("Long idling: idle threshold minutes per level, Warning/Critical tiers, repeat interval while idling continues", "P1"),
    ("Long idling: idle detection by ignition, or by external voltage / OBD RPM for devices without ignition wire", "P1"),
    ("Long idling: tolerance so small creeping movement doesn't reset the timer", "P1"),
    ("Long idling: exclusions by geofence (e.g. loading bay) and by time window; separate 'idling with AC on' alert", "P1"),
    ("Long idling: end-of-idle summary with total duration and estimated fuel wasted", "P2"),
    ("Company default recipient lists: default email list, default SMS numbers, default WhatsApp numbers, default push users", "P1"),
    ("Per alert type and per level: separate Email list, SMS list, WhatsApp list and Push list", "P1"),
    ("List mode per channel: Use default list / Default + additional / Only this list / None", "P1"),
    ("Recipients can be users, roles (e.g. all Branch Managers), dynamic contacts (assigned users, current driver, branch manager), contact groups or typed emails/numbers", "P1"),
    ("Branch and group default lists, inherited like other alert settings", "P1"),
    ("Severity routing: e.g. Warning → email only, Critical → email + SMS + WhatsApp", "P1"),
    ("Validation: email format, Indian mobile (+91, 10 digits), duplicates removed; optional OTP verification for external numbers", "P1"),
    ("'Send test' button per alert to check every list", "P1"),
    ("Per-recipient delivery log: sent, delivered, failed, with retry", "P1"),
    ("Unsubscribe link in emails and opt-out for external SMS numbers (Critical/SOS can be marked non-optional for staff)", "P2"),
    ("Plan limits on SMS/WhatsApp recipients per alert and per month; usage shown before saving", "P1"),
])
h2("Message templates (email, SMS, WhatsApp, push)")
features("TPL", [
    ("Template library: view every email, SMS, WhatsApp and push template, filtered by alert type, channel, language, level", "P1"),
    ("Templates for every alert type plus system messages: OTP, password reset, welcome, report emails, invoices, renewal reminders, parent notifications", "P1"),
    ("Levels: system default (Super Admin) → partner (P4) → company override; 'reset to default' at any time", "P1"),
    ("Email editor: subject, rich-text/HTML body, company logo and colours, footer", "P1"),
    ("Placeholders per alert type, inserted from a list: {{vehicle_name}}, {{plate}}, {{alert_type}}, {{speed}}, {{limit}}, {{location}}, {{map_link}}, {{time}}, {{driver_name}}, {{geofence}}, {{duration}}…", "P1"),
    ("Live preview with sample or real data; send test to my email/mobile", "P1"),
    ("Validation: unknown placeholders blocked, required placeholders enforced", "P1"),
    ("SMS editor: character counter, parts count (160 GSM / 70 Unicode for Tamil/Hindi), cost estimate", "P1"),
    ("SMS DLT workflow: template text + DLT template ID + sender ID stored; only DLT-approved templates can be activated", "P1"),
    ("Companies choose among approved SMS templates per alert and map variables; new wording goes through an approval request", "P1"),
    ("WhatsApp templates with Meta approval status (pending/approved/rejected) synced from the provider", "P2"),
    ("Push notification title/body templates with sound and priority per alert type", "P1"),
    ("Version history with who/when, compare and restore", "P1"),
    ("Language variants per template (English first; Tamil/Hindi later)", "P4"),
    ("Permission 'Message templates' (View/Edit) in menu-role mapping", "P1"),
    ("Template Master page: one list of all templates (email, SMS, WhatsApp, push; alert and system messages)", "P1"),
    ("Master columns: name, purpose/alert type, channel, level, language, status, DLT/Meta ID, used by, last changed by/at", "P1"),
    ("Master filters and search: channel, alert type, level, status, language, 'overridden by my company', 'not approved'", "P1"),
    ("Row actions: view, edit, preview, send test, duplicate, version history, reset to default, activate/deactivate", "P1"),
    ("Super Admin master shows system templates plus how many companies override each one, with drill-down", "P1"),
    ("Export the template list (Excel/CSV), e.g. for DLT registration", "P1"),
])
h2("Geofences and points of interest")
features("GEO", [
    ("Shapes: circle, polygon, rectangle", "P1"),
    ("Route corridor (line + width) for deviation alerts", "P2"),
    ("Create by drawing on map (web and mobile)", "P1"),
    ("Create from address/place search with radius", "P1"),
    ("Create from a vehicle's current location or from my phone's location", "P1"),
    ("Create from a stop, POI or route (route stops become geofences automatically)", "P1"),
    ("Create from OSM boundaries: city, district, state, pincode area", "P2"),
    ("Bulk import from Excel/CSV, KML, GeoJSON", "P2"),
    ("Details: name, category (Home, Office, Depot, Customer, School, Parking, Fuel station, No-go, Safe zone), colour, icon, address", "P1"),
    ("Owned by a branch or shared company-wide", "P1"),
    ("Applies to all, a branch, a vehicle group or selected objects", "P1"),
    ("Checks: entry, exit, both; stayed longer than X min; zone speed limit; no-go; keep-inside", "P1"),
    ("Time windows (days and hours)", "P1"),
    ("Edit: drag points, move, resize; enable/disable; change history preserved for past reports", "P1"),
    ("List with search, filter and bulk actions", "P1"),
    ("Anti-flapping: boundary buffer and minimum dwell before enter/exit counts", "P1"),
    ("In-memory spatial index — checks in microseconds at 10,000+ devices", "P1"),
    ("Plan limits on number of geofences", "P1"),
    ("Points of interest with arrival detection", "P2"),
    ("Reports: visits (in/out/duration), entry/exit log, time per geofence per day, no-go violations", "P2"),
])

h2("Device commands")
features("CMD", [
    ("Engine cut-off / restore, request location", "P1"),
    ("Change interval, reboot, set server/APN, custom commands", "P2"),
    ("Commands offered depend on the device model", "P1"),
    ("Status: sent → acknowledged / failed / expired; full audit log", "P1"),
    ("Safety: permission-based, confirmation dialog, blocked above a configurable speed", "P1"),
    ("Offline queue with expiry; SMS fallback through an SMS gateway", "P2"),
    ("Watch commands: call device, listen-in, two-way calling", "P2"),
])

h2("Video and cameras")
features("VID", [
    ("Camera capabilities in device model: channels, live, playback, snapshot, two-way audio, protocol", "P3"),
    ("Live view of 1–8 channels beside the map", "P3"),
    ("On-demand streams with auto-stop to save SIM data and bandwidth", "P3"),
    ("Snapshots, manual or automatic on alerts", "P3"),
    ("Alarm video clips attached to alerts and timeline", "P3"),
    ("Playback from device SD card, synced with route playback", "P3"),
    ("Two-way talk with driver", "P3"),
    ("Sources: JT/T 1078, RTMP, RTSP/ONVIF IP cameras, photo uploads", "P3"),
    ("Separate permissions and audit log for live view, playback and download", "P3"),
    ("Video retention and minute limits per plan", "P3"),
])

h2("Fuel monitoring")
features("FUEL", [
    ("Sources: analog/digital fuel sensor, OBD fuel level, manual fill-up entries", "P2"),
    ("Calibration table per tank; multiple tanks per vehicle", "P2"),
    ("Smoothing of sloshing and slope effects", "P2"),
    ("Refuel and theft/drain detection with time, litres and location", "P2"),
    ("Consumption per trip/day, km/L, idle fuel, sensor vs manual comparison", "P2"),
])

h2("Drivers and driving behaviour (Business accounts)")
features("DRV", [
    ("Driver profile: name, photo, phones, address, DOB, blood group, emergency contact, employee ID, joining date, branch", "P1"),
    ("Licence: number, vehicle classes (LMV, MCWG, HMV, Transport…), issue/expiry, RTO, document upload", "P1"),
    ("Commercial: transport/PSV badge and expiry, medical fitness, police verification status", "P1"),
    ("Optional ID proof upload (Aadhaar masked to last 4 digits, encrypted)", "P1"),
    ("Driver status: Active, On leave, Inactive (history kept)", "P1"),
    ("Driver → vehicle assignment with from–to times; one driver per vehicle at a time; full history", "P1"),
    ("Current driver shown on map, trips, alerts, reports", "P1"),
    ("Warning (or block, per company) when licence class doesn't cover the vehicle or licence is expired", "P1"),
    ("Licence/badge/medical expiry reminders at 30, 15, 7 days and on expiry", "P2"),
    ("Driver identification by RFID/iButton or app login", "P2"),
    ("Driver score 0–100 with configurable weights; rankings and trends", "P2"),
    ("Fatigue: continuous driving without a break", "P2"),
    ("Licence verification against Sarathi via authorised provider", "P4"),
])

h2("Routes and trips (Driver → Vehicle → Route → Trip)")
features("RTE", [
    ("Route = ordered stops (start → stops → end) with arrival radius, planned arrival/departure, planned wait", "P1"),
    ("Route path drawn or generated along roads (OSRM), with corridor width", "P2"),
    ("Route schedule: days of week, start time", "P1"),
    ("Copy, edit, archive; editing never alters past trips", "P1"),
    ("Trip = Driver + Vehicle + Route + date/time; one-off or recurring (auto-generated)", "P1"),
    ("Trip states: Scheduled → Started → In progress → Completed / Incomplete / Cancelled", "P1"),
    ("Auto start on leaving the start point and auto complete at the end; manual override", "P1"),
    ("Per stop: planned vs actual arrival, in time, out time, dwell, status (on time/late/early/skipped)", "P1"),
    ("Unscheduled stops recorded with location and duration", "P1"),
    ("Live trip view: progress, current stop, ETA to next stop, delay", "P1"),
    ("Trip alerts (see alert catalogue)", "P1"),
    ("Complete trip record: path, stops, distance, duration, speeds, idle, alerts, score, fuel, video", "P1"),
    ("Trip playback with planned route and stops over actual path", "P1"),
    ("Trip reports: on-time performance by route/driver/vehicle, stop delays, planned vs actual km", "P1"),
    ("Routes optionally assignable to delivery persons", "P2"),
])

h2("Passenger management (students and employees)")
features("PAS", [
    ("Student profile: name, photo, admission no., class/section, campus, DOB, blood group, medical notes, guardians, address, RFID", "P2"),
    ("Employee profile: name, photo, employee ID, department, designation, shift, phone, address, emergency contact, gender, RFID", "P2"),
    ("Bulk import; active/inactive with history", "P2"),
    ("Mapping passenger → vehicle, route, pickup stop and drop stop (separate morning/evening)", "P2"),
    ("Mapping history with effective dates; seat-capacity warnings", "P2"),
    ("Passenger list per trip and per stop", "P2"),
    ("Attendance optional per company: Off / RFID / in-app / both (merged, no duplicates)", "P2"),
    ("Boarding and drop records with time and location; wrong-vehicle detection", "P2"),
    ("Safety alerts: student not dropped, wrong bus, absent, night-drop rules for women employees", "P2"),
    ("VeeTracer Parent app: own children only — profile, bus live location in trip hours, ETA, boarding status, trip history", "P2"),
    ("Parent notifications: bus started, approaching stop, boarded, dropped, delayed", "P2"),
    ("Multiple children per parent login (even on different buses)", "P2"),
    ("Employee \"Track my cab\": live cab, ETA, boarding confirmation, SOS", "P2"),
    ("Reports: attendance, absentees, boarding logs, occupancy, notification log", "P2"),
    ("Module switch so it can be bundled or sold as an add-on later", "P2"),
])

h2("Mobile tracking for people and delivery staff")
features("MOB", [
    ("Phone becomes the tracker; Start Duty / End Duty", "P1"),
    ("Background tracking (Android foreground service; iOS within its limits)", "P1"),
    ("Adaptive interval to save battery; offline buffering and later upload", "P1"),
    ("Person shown on map with photo, last update and phone battery", "P1"),
    ("Consent record; tracking only during duty", "P1"),
    ("Ad-hoc tracking: SMS/WhatsApp invite link to share location for a set time", "P4"),
])

h2("Maintenance and documents")
features("MNT", [
    ("Service schedules by km, engine hours or date", "P2"),
    ("Vehicle documents with expiry reminders: insurance, permit, fitness, PUC", "P2"),
    ("Maintenance log and costs", "P2"),
])

h2("Reports")
features("RPT", [
    ("Summary report per vehicle, day-wise / week-wise / month-wise: distance, running, idle, stop, offline time, trips, max/avg speed, overspeed count, first start, last stop", "P1"),
    ("Running + idle + stop + offline always add up to the full period; totals per vehicle and group", "P1"),
    ("Trips, stops, idle, alerts reports", "P1"),
    ("Geofence visits, ignition, overspeed, AC usage, engine hours, utilisation", "P2"),
    ("Fuel, driver score, attendance reports", "P2"),
    ("Export to Excel, PDF, CSV", "P1"),
    ("Scheduled reports: vehicles (branch / selection / vehicle group), report types, daily/weekly/monthly, time, format, recipients", "P1"),
    ("Scheduled report runs with the scheduler's current access; history, re-download, pause/resume", "P1"),
    ("Periods in company timezone; weeks start Monday (configurable); calendar months", "P1"),
    ("Pre-computed daily summaries so fleet-wide monthly reports open in seconds", "P1"),
    ("Charts: daily distance trend, running vs idle split", "P1"),
])

h2("Dashboards")
features("DSH", [
    ("Company dashboard: status counts, mini live map, today's distance/running/idle, utilisation, alerts by type", "P1"),
    ("Widgets: fuel, driver ranking, maintenance due, documents expiring, devices not reporting, plan usage", "P2"),
    ("User-customisable widget layout", "P2"),
    ("Compact mobile dashboard; Individual \"My Vehicles\" home", "P1"),
    ("Super Admin dashboard: customers, devices online, data intake rate, revenue, renewals, failed payments, server health", "P1"),
    ("Partner dashboard", "P4"),
])

h2("Billing and subscriptions")
features("BIL", [
    ("Fixed plans with monthly and annual prices in INR, separate for Business and Individual", "P1"),
    ("Plan limits: devices, users, history days, geofences, channels, video minutes, modules", "P1"),
    ("Razorpay Subscriptions: auto-renew, grace period, auto-suspend, reactivation", "P1"),
    ("GST invoices (CGST/SGST/IGST, GSTIN), PDF and email", "P1"),
    ("SMS/WhatsApp credit packs", "P2"),
    ("Upgrade/downgrade with proration; coupons and discounts", "P2"),
])

h2("Integrations")
features("INT", [
    ("REST API with per-company API keys and OpenAPI/Swagger documentation", "P1"),
    ("Webhooks for positions, alerts, trips with signed payloads and retries", "P2"),
    ("WebSocket live stream for customer systems", "P2"),
    ("Raw data forwarding to other platforms, ERP or government servers (AIS-140)", "P2"),
    ("Inbound positions from other GPS platforms", "P2"),
])

h2("Data management")
features("DATA", [
    ("Retention per company 30/60/90/180 days (6 months max), automatic deletion, export before deletion", "P1"),
    ("Bad-point filtering: invalid fix, 0,0, low satellites/accuracy, impossible jumps (limit per object type), parked drift, duplicates, future timestamps", "P1"),
    ("Filtered points flagged, never deleted; raw packets logged for reprocessing", "P1"),
    ("Late/out-of-order points (sent after no-signal periods) placed correctly in history; summaries recalculated", "P1"),
    ("All storage in UTC; display in company/user timezone; device time offset per model", "P1"),
    ("Odometer and engine hours carried across device swaps", "P1"),
])

h2("Maps (self-hosted OpenStreetMap)")
features("OSM", [
    ("India OSM extract → own vector tiles (Planetiler + Martin), displayed with MapLibre", "P1"),
    ("Reverse geocoding (address lookup) with Nominatim/Photon and caching", "P1"),
    ("Routing, ETA and road snapping with OSRM", "P2"),
    ("Monthly map data refresh", "P2"),
])

h2("Mobile apps")
features("APP", [
    ("Three mobile apps from one Flutter codebase with shared modules: VeeTracer Admin, VeeTracer (role-based), VeeTracer Parent", "P1"),
    ("VeeTracer Admin: dashboard, live map, list, vehicle tabs, history, trips, alerts + management (vehicles, drivers, routes, geofences, alert settings, users)", "P1"),
    ("VeeTracer role-based app: after login the menus, home screen and permissions are built from the user's role and permissions", "P1"),
    ("A user with several roles (e.g. driver who is also a viewer) can switch role inside the app", "P2"),
    ("Push notifications with alert sounds and critical-alert handling (all apps)", "P1"),
    ("Commands from mobile (Admin app, permission-based)", "P1"),
    ("Live video in mobile", "P3"),
    ("Offline mode: cached data, queued actions (attendance, fuel entries, inspections) synced when online", "P2"),
    ("Tamil and Hindi languages", "P4"),
])
h2("Driver experience (VeeTracer app, Driver role)")
features("DRA", [
    ("Login by mobile OTP; home shows today's duty, assigned vehicle and trips", "P1"),
    ("Start Duty / End Duty; phone tracking during duty if the vehicle has no device", "P1"),
    ("Current trip: route on map, ordered stop list with planned times, next stop ETA, turn-by-turn via Google Maps / OSM navigation app", "P1"),
    ("Automatic stop arrival/departure; manual 'Arrived' / 'Departed' / 'Skip with reason'", "P1"),
    ("SOS / panic button with location", "P1"),
    ("Passenger list per stop and attendance marking (driver or attendant role)", "P2"),
    ("Pre-trip vehicle inspection checklist with photos (tyres, lights, brakes, cleanliness)", "P2"),
    ("Fuel entry with receipt photo and odometer", "P2"),
    ("Own driving score, events and tips; overspeed voice warning while driving", "P2"),
    ("My documents: licence, badge, medical expiry reminders", "P2"),
    ("Trip history with animated replay", "P1"),
])
h2("Employee experience (VeeTracer app, Employee role)")
features("EMA", [
    ("Login by mobile OTP; home shows today's pickup and drop, cab, driver photo and phone", "P2"),
    ("Track my cab live with ETA to my pickup point; 'cab approaching' notification", "P2"),
    ("Boarding confirmation (RFID tap, attendant marking, or confirm in app)", "P2"),
    ("SOS button and share-my-ride link to family during the trip", "P2"),
    ("My shift and roster; request pickup point or shift change (approval by admin)", "P2"),
    ("Trip history and trip rating/feedback", "P2"),
])


h2("Super Admin console")
features("ADM", [
    ("All partners, companies, users and devices; search across the platform", "P1"),
    ("Activate, suspend, change plan, change account type, enable modules", "P1"),
    ("Device model catalogue and capability management", "P1"),
    ("Device and SIM inventory, assignment to customers", "P1"),
    ("Plans and pricing management", "P1"),
    ("Platform settings: SMS/WhatsApp/email providers, templates, map services", "P1"),
    ("Revenue, renewals, failed payments, invoices", "P1"),
    ("System health: ingestion rate, queue depth, latency, connected devices, errors", "P1"),
])

h2("Performance and scalability")
features("PERF", [
    ("Designed and load-tested for 10,000+ devices (~1,000 positions per second peak)", "P1"),
    ("Hot path (live + alerts) processed in memory, separated from storage and reporting", "P1"),
    ("Targets: device → map under 2 s, alert → in-app under 2 s, push under 5 s (95th percentile)", "P1"),
    ("Horizontally scalable gateways and workers", "P1"),
    ("TimescaleDB compression and partitioning", "P1"),
    ("Durable queue: no data lost during spikes or restarts", "P1"),
    ("Live updates batched per viewer (~1 s) and filtered by scope and viewport", "P1"),
    ("10,000-device simulator for load testing", "P1"),
    ("Monitoring and alerting (Prometheus + Grafana)", "P1"),
    ("Daily backups, point-in-time restore, disaster-recovery runbook", "P1"),
])
raw("<!--FEATURE_TOTAL-->")

# ---------------------------------------------------------------------------
h1("System architecture")
h2("Overview")
raw("""
<div class="arch">
  <div class="layer"><div class="lbl">Sources</div>
    <div class="box">Concox / GT06<br><small>TCP</small></div><div class="box">AIS-140<br><small>TCP</small></div>
    <div class="box">Teltonika, OBD, watches, others<br><small>TCP / Traccar gateway</small></div>
    <div class="box">Phones<br><small>HTTPS</small></div><div class="box">Dashcams / MDVR<br><small>JT808 + JT1078</small></div></div>
  <div class="arrow">▼</div>
  <div class="layer"><div class="lbl">Ingestion</div>
    <div class="box wide hot">Device Gateways — protocol decoders, ACKs, command channel, raw packet log<br><small>stateless, scale out behind a TCP load balancer</small></div>
    <div class="box">Media Server<br><small>ZLMediaKit</small></div></div>
  <div class="arrow">▼</div>
  <div class="layer"><div class="lbl">Stream</div>
    <div class="box wide hot">Valkey Streams — durable queue, partitioned by device<br><small>live device state cache · pub/sub</small></div></div>
  <div class="arrow">▼</div>
  <div class="layer"><div class="lbl">Processing</div>
    <div class="box hot">Position Processor<br><small>filter, normalise, status, trips</small></div>
    <div class="box hot">Rules Engine<br><small>alerts in memory</small></div>
    <div class="box">Notification Workers<br><small>push, SMS, email, WhatsApp, webhook</small></div>
    <div class="box">Batch Writer<br><small>bulk insert</small></div>
    <div class="box">Jobs<br><small>offline, summaries, retention, reports</small></div></div>
  <div class="arrow">▼</div>
  <div class="layer"><div class="lbl">Data</div>
    <div class="box">PostgreSQL + TimescaleDB<br><small>business data + positions</small></div>
    <div class="box">Object storage<br><small>SeaweedFS / MinIO: video, documents, reports</small></div>
    <div class="box">Maps server<br><small>Martin tiles, Nominatim, OSRM</small></div></div>
  <div class="arrow">▼</div>
  <div class="layer"><div class="lbl">Access</div>
    <div class="box hot">Realtime Gateway<br><small>Socket.IO, per-viewer fan-out</small></div>
    <div class="box">REST API<br><small>NestJS</small></div>
    <div class="box">Public API &amp; Webhooks</div></div>
  <div class="arrow">▼</div>
  <div class="layer"><div class="lbl">Clients</div>
    <div class="box">Web (React)</div><div class="box">Admin app &amp; VeeTracer app (Flutter)</div><div class="box">Parent app (Flutter)</div><div class="box">Customer systems</div></div>
</div>
<p class="legend"><span class="hotkey"></span> Hot path — optimised for live tracking and alert latency.</p>
""")
h2("Life of a position (hot path)")
table(["Step", "What happens", "Budget"], [
    ["1", "Device sends packet; gateway decodes, ACKs immediately, appends raw packet and normalised position to the stream", "&lt; 50 ms"],
    ["2", "Position processor reads the stream: bad-point filter, timezone, normalise attributes, update movement status, odometer, trip state", "&lt; 100 ms"],
    ["3", "Rules engine evaluates the object's rules against in-memory state (previous position, geofence membership via spatial index, cooldowns)", "&lt; 50 ms"],
    ["4", "Live state written to Valkey; update published to the realtime gateway; alerts published to notification workers", "&lt; 50 ms"],
    ["5", "Realtime gateway batches per viewer (≤ 1 s), filters by scope and viewport, pushes to web/mobile", "≤ 1 s"],
    ["6", "In parallel (cold path): batch writer bulk-inserts positions into TimescaleDB; summaries and reports update later", "async"],
])
note("Database writes are never on the critical path for the live map or alerts. If the database slows down, "
     "the stream absorbs the backlog and nothing is lost.", "ok")
h2("Technology stack (open source first)")
table(["Layer", "Choice", "Licence / cost"], [
    ["Backend API, gateways, workers", "Node.js + TypeScript (NestJS)", "MIT — free"],
    ["Database", "PostgreSQL 16 + TimescaleDB (+ PostGIS for spatial queries)", "Free (TimescaleDB community licence)"],
    ["Cache, queues, pub/sub", "Valkey (open-source Redis fork) + BullMQ", "BSD / MIT — free"],
    ["Realtime", "Socket.IO (Valkey adapter for multiple nodes)", "MIT — free"],
    ["Web app", "React + TypeScript + Vite, <b>Tailwind CSS</b> + shadcn/ui (Radix) components, MapLibre GL, Apache ECharts", "MIT/Apache — free"],
    ["Mobile apps", "Flutter (maplibre, geolocator, background service)", "BSD — free"],
    ["Map tiles", "OSM India extract → Planetiler → Martin", "ODbL data, Apache/MIT tools — free"],
    ["Geocoding / routing", "Nominatim (or Photon), OSRM", "GPL/Apache/BSD — free"],
    ["Other device brands", "Traccar (as protocol gateway)", "Apache 2.0 — free"],
    ["Video", "ZLMediaKit (JT1078, RTMP, RTSP → WebRTC/HLS/FLV)", "MIT — free"],
    ["Object storage", "SeaweedFS (or MinIO)", "Apache 2.0 / AGPL — free"],
    ["Monitoring", "Prometheus, Grafana, Loki", "Free"],
    ["Push notifications", "Firebase Cloud Messaging", "Free (proprietary service)"],
    ["Email", "Amazon SES (or self-hosted Postal)", "~$0.10 per 1,000 emails"],
    ["Packaging", "Docker Compose (single/multi server); Kubernetes optional later", "Free"],
])
h2("Scaling path")
table(["Stage", "Devices", "Deployment"], [
    ["Launch", "up to ~3,000", "2 servers: application server (gateways, API, workers, Valkey) + database server; maps on the app server or a third box"],
    ["Growth", "~10,000", "2 gateway/API nodes behind a load balancer, dedicated worker node, database server with replica, maps server, media server (P3)"],
    ["Beyond", "50,000+", "More gateway/worker nodes, stream partitions, TimescaleDB multi-node or read replicas, Kubernetes"],
])

# ---------------------------------------------------------------------------
h1("Device integration")
h2("Device model catalogue")
p("Every supported model is described once in the catalogue, maintained by the Super Admin. Everything the "
  "customer sees for a device is derived from it.")
table(["Catalogue field", "Example (Concox GT06N)"], [
    ["Brand / model / protocol", "Concox / GT06N / GT06"],
    ["Capabilities", "ignition, SOS, power-cut, engine cut-off, battery, LBS"],
    ["Extra fields", "external voltage (V), GSM signal (0–4), oil/electric relay state"],
    ["Commands", "engine cut-off, restore, locate, set interval (with SMS equivalents)"],
    ["Time handling", "UTC"],
    ["Filtering defaults", "max speed 200 km/h, parked-drift radius 30 m"],
    ["Default alert templates", "power cut, SOS, ignition on/off, overspeed"],
])
h2("Capabilities")
p("ignition · ac · door · fuel · temperature · sos · power_cut · battery · engine_cut · harsh_events · crash · "
  "obd · dtc · rfid · camera(channels) · adas · dms · two_way_audio · heart_rate · steps · fall · wear_detect · "
  "lbs · wifi_location · seatbelt")
h2("Normalised fields")
table(["Group", "Fields"], [
    ["Core (every position)", "fix time, server time, latitude, longitude, speed, course, altitude, satellites, accuracy/HDOP, valid fix, location source (GPS/LBS/Wi-Fi)"],
    ["Common status", "ignition, motion, battery %, external voltage, GSM signal, odometer, engine hours"],
    ["Model-specific (attributes)", "ac, door, fuel level/litres, temperatures, RPM, coolant temp, engine load, DTC list, heart rate, steps, RFID tag, ADAS/DMS events…"],
])
p("Each protocol decoder maps vendor codes into these names, so the same alert, report or map field works for any brand.")
h2("Protocol plan")
table(["Protocol / source", "Approach", "Phase"], [
    ["Concox GT06 family", "Native decoder in our gateway", badge("P1")],
    ["Phone (VeeTracer app), OsmAnd/Traccar Client", "HTTPS ingestion API", badge("P1")],
    ["AIS-140", "Native decoder; forwarding to state backend as required", badge("P2")],
    ["Teltonika", "Native decoder", badge("P2")],
    ["200+ other brands", "Traccar gateway forwarding normalised positions to our stream", badge("P2")],
    ["JT/T 808 + 1078 (dashcams, MDVR)", "Native JT808 decoder + ZLMediaKit for video", badge("P3")],
])
h2("Device swap")
ul([
    "Positions, trips, alerts and summaries are stored against the <b>object</b> (and the device that produced them).",
    "Swapping closes the old assignment and opens a new one; odometer and engine hours carry over with an offset.",
    "Rules needing a capability the new model lacks are paused and flagged on the object page.",
])
h2("Data quality: jumps, drift and late data")
table(["Problem", "Handling"], [
    ["Invalid fix, 0,0, too few satellites, poor accuracy", "Flagged invalid; not shown or counted"],
    ["Impossible jump", "Implied speed between points above the object-type limit (e.g. car 200 km/h, pet 50 km/h) → flagged"],
    ["Parked drift", "With ignition off and no motion, position frozen; movement under ~30 m ignored"],
    ["Duplicates / future timestamps", "Dropped / clamped and flagged"],
    ["Late and out-of-order points", "Inserted by fix time; trips and daily summaries for that period recalculated"],
    ["LBS / Wi-Fi fixes", "Shown as approximate; excluded from distance"],
])
note("Flagged points are kept (never deleted) and raw packets are logged, so data can always be audited or reprocessed with better rules.")
h2("Commands")
p("Commands go out through the device's open TCP connection when online; otherwise they wait in a queue with "
  "an expiry and can fall back to SMS. Each command records who sent it, when, the device response and final status.")

# ---------------------------------------------------------------------------
h1("Data model")
p("Main entities, grouped by domain. Every tenant-owned table carries <code>company_id</code> (and <code>partner_id</code> "
  "through the company) for isolation. Times are stored in UTC.")
table(["Domain", "Entity", "Key fields / relations"], [
    ["Tenancy", "Partner", "name, branding, domain, wholesale pricing"],
    ["Tenancy", "Company", "partner, account type (Business/Individual), status, timezone, units, retention days, modules, plan"],
    ["Tenancy", "Branch", "company, name, address"],
    ["Access", "User", "company, name, email, mobile, password hash, 2FA, status, manager (parent user)"],
    ["Access", "Role, Permission, MenuPermission", "role → menu → actions (V/C/E/D/special)"],
    ["Access", "UserRole, UserBranch, UserObject", "user ↔ role, user ↔ branches, user ↔ individual objects"],
    ["Access", "Session, OtpCode, PasswordReset, ApiKey, AuditLog", "security and traceability"],
    ["Catalogue", "DeviceModel", "brand, model, protocol, capabilities, field definitions, commands, time offset, filter defaults"],
    ["Assets", "Device", "IMEI/unique ID, model, SIM, company, status, firmware, ingest token"],
    ["Assets", "Sim", "number, operator, expiry, device"],
    ["Assets", "TrackedObject", "company, branch, type, name, icon, type fields, custom fields, speed limit, odometer offset"],
    ["Assets", "DeviceAssignment", "device ↔ object, from, to"],
    ["Assets", "VehicleGroup (+ members)", "saved groups for filters/reports"],
    ["Telemetry", "Position <i>(hypertable)</i>", "object, device, fix time, lat, lng, speed, course, altitude, satellites, accuracy, ignition, flags, attributes (JSON)"],
    ["Telemetry", "RawPacket <i>(hypertable, short retention)</i>", "device, received at, bytes"],
    ["Telemetry", "LiveState <i>(Valkey)</i>", "last valid position, status, status since, geofence membership, trip state"],
    ["Telemetry", "DailySummary", "object, local date, distance, running/idle/stop/offline seconds, max/avg speed, trips, fuel"],
    ["Telemetry", "AutoTrip, Stop", "object, start/end, distance, duration, speeds"],
    ["Geo", "Geofence (+ versions)", "company, branch, shape, geometry, category, colour, rules, time windows, applies-to"],
    ["Geo", "Poi", "name, location, radius, category"],
    ["Alerts", "AlertRule", "scope, type, parameters, schedule, cooldown, channels, recipients, escalation"],
    ["Alerts", "AlertSetting", "level (company/branch/group/object), target, alert type, overridden fields only, priority among groups"],
    ["Alerts", "AlertTemplate", "named pack of alert settings applied to groups/objects"],
    ["Alerts", "AlertSnooze", "object or group, alert types, until, reason, by"],
    ["Alerts", "UserAlertSubscription, ContactGroup", "per-user alert types/objects/channels; external contacts for notifications"],
    ["Alerts", "MessageTemplate (+ versions)", "level (system/partner/company), purpose (alert type or system message), channel, language, subject, body, placeholders, DLT template ID, sender ID, approval status"],
    ["Alerts", "RecipientList", "level, target, alert type, severity, channel, mode (default/add/only/none), entries (user, role, dynamic, contact group, email, mobile)"],
    ["Alerts", "Alert", "rule, object, type, priority, time, location, data, status, assignee, notes, ack/resolve by and when"],
    ["Alerts", "NotificationLog", "alert, channel, recipient, status, cost"],
    ["Commands", "Command", "device, type, payload, sent by, channel, status, response, expiry"],
    ["Drivers", "Driver", "personal, licence, badge, medical, police verification, RFID, status"],
    ["Drivers", "DriverAssignment", "driver ↔ object, from, to"],
    ["Routes", "Route, RouteStop", "ordered stops, planned times, path, corridor, schedule"],
    ["Routes", "Trip, TripStop", "route snapshot, driver, vehicle, status, planned vs actual per stop"],
    ["Passengers", "Student, Employee, Guardian", "profiles; guardian ↔ student"],
    ["Passengers", "PassengerAssignment", "passenger ↔ vehicle, route, pickup/drop stop, shift, effective from/to"],
    ["Passengers", "Attendance", "trip, passenger, boarded/dropped time and location, source (RFID/app)"],
    ["Fuel", "FuelTank, FuelCalibration, FuelEvent, FuelEntry", "tanks, calibration tables, refuel/theft events, manual fill-ups"],
    ["Maintenance", "ServiceSchedule, ServiceRecord, Document", "km/date/hours schedules, logs, expiring documents"],
    ["Video", "VideoClip, VideoSession", "device, channel, time range, storage key / who watched"],
    ["Reports", "ReportSchedule, ReportRun", "owner, scope, types, frequency, format, recipients / generated files"],
    ["Billing", "Plan, Subscription, Invoice, Payment, CreditPack", "limits, prices, Razorpay IDs, GST details"],
    ["Integrations", "Webhook, ForwardTarget", "URL, events, secret, status"],
])
h2("Storage estimates")
table(["Assumption", "2,000 devices", "10,000 devices"], [
    ["Average positions per device per day (mix of moving and parked)", "~2,900", "~2,900"],
    ["Positions per day", "~5.8 million", "~29 million"],
    ["Peak ingestion (10 s interval, all moving)", "~200 / s", "~1,000 / s"],
    ["Compressed position storage, 180 days", "~25–40 GB", "~130–200 GB"],
    ["Raw packet log (30 days)", "~30 GB", "~150 GB"],
])
p("Video storage is sized separately (about 0.5 GB per stream-hour) and governed by video retention per plan.")

# ---------------------------------------------------------------------------
h1("Alerts engine")
h2("Rule structure")
table(["Part", "Description", "Example"], [
    ["Scope", "Objects, branch, vehicle group, device model, or all", "All trucks in Chennai branch"],
    ["Type + parameters", "From the alert catalogue, filtered by capability", "Geofence exit — \"Chennai Depot\""],
    ["Schedule", "Days and time windows in company timezone", "Mon–Sat, 20:00–06:00"],
    ["Cooldown / de-duplication", "Minimum gap between repeats per object", "15 minutes"],
    ["Priority", "Info, Warning, Critical (critical stays on screen)", "Critical"],
    ["Channels &amp; recipients", "In-app, push, email, SMS, WhatsApp, webhook — recipients per channel", "SMS to owner, email to manager"],
    ["Escalation", "If not acknowledged in X min, notify next level", "After 10 min → Admin"],
])
h2("Configuration levels and inheritance")
raw("""
<div class="tree">
<div class="node root">Company default <small>applies to every object</small></div>
<div class="branch">
  <div class="node">Branch <small>overrides company</small></div>
  <div class="branch">
    <div class="node">Vehicle group <small>overrides branch; group priority decides if a vehicle is in several groups</small></div>
    <div class="branch">
      <div class="node leaf">Individual vehicle / person / pet <small>final override — most specific wins</small></div>
    </div>
  </div>
</div>
</div>
""")
table(["Example: Overspeed", "Setting", "Effective for"], [
    ["Company default", "On, 80 km/h, push + in-app", "All vehicles"],
    ["Branch: Chennai", "Adds SMS to branch manager", "Chennai vehicles"],
    ["Group: School buses", "40 km/h, priority Critical, 06:00–19:00", "School buses (any branch)"],
    ["Vehicle: TN-01-AB-1234", "Off until 25 Oct (in workshop)", "That vehicle only"],
])
ul([
    "Resolution is per alert type and per setting, so a vehicle can inherit the schedule from its group but have its own threshold.",
    "The resolved configuration per object is pre-computed and cached in the rules engine; any change at any level is recompiled for affected objects within seconds, with no impact on alert latency.",
    "Recipients are resolved at send time: level recipients + user subscriptions + contact groups, filtered by each user's data scope (nobody receives alerts for vehicles they can't see).",
])
h2("Overspeed and long-idling settings")
p("Every parameter below can be set at company, branch, vehicle group or individual level. Defaults are starting values only.")
h3("Overspeed")
table(["Setting", "Meaning", "Default"], [
    ["Speed limit", "Limit for the level; vehicle-type defaults offered (bike, car, truck, bus, school bus)", "Car 80, truck 60, bus 60, school bus 40, bike 60 km/h"],
    ["Tolerance", "Allowance above the limit before it counts", "+5 km/h"],
    ["Minimum duration", "Must stay over the limit this long (filters GPS spikes)", "10 s"],
    ["Severity tiers", "Warning when over the limit; Critical when over by X", "Critical at +20 km/h"],
    ["Time-based limit", "Different limit in a time window", "Off (e.g. night 22:00–05:00 → 50 km/h)"],
    ["Zone limit", "Lower limit inside chosen geofences (school, plant, city)", "Set per geofence"],
    ["Repeat", "One alert per overspeed event; optionally repeat every N min while it continues", "No repeat"],
    ["End-of-event summary", "When speed drops below limit: max speed, duration, distance over limit", "On (in-app only)"],
    ["Schedule, channels, recipients, cooldown", "As for every alert", "Inherited"],
])
note("Overspeed is calculated on the server from clean GPS points, so it behaves the same for every device brand. "
     "Where a device has its own overspeed alarm, the limit can also be pushed to the device by command. Each event feeds the driver score and overspeed report.")
h3("Long idling")
table(["Setting", "Meaning", "Default"], [
    ["Idle definition", "Engine on and speed below threshold", "Speed &lt; 3 km/h"],
    ["Engine-on source", "Ignition input; for devices without it, external voltage above a level or OBD RPM &gt; 0", "Ignition, else voltage &gt; 13.2 V"],
    ["Idle threshold", "Minutes of continuous idling before alerting", "10 min"],
    ["Severity tiers", "Warning at the threshold, Critical at a longer duration", "Critical at 30 min"],
    ["Movement tolerance", "Small creeping movement that does not reset the idle timer", "&lt; 50 m"],
    ["Repeat", "Re-alert every N min while idling continues", "Every 15 min"],
    ["Exclusions", "No alert inside chosen geofences (loading bay, depot) or time windows", "None"],
    ["AC idling", "Separate alert when idling with AC on (devices with AC input)", "Off"],
    ["End-of-idle summary", "Total idle duration and estimated fuel wasted (fuel sensor, or idle L/h per vehicle type)", "On (in-app only)"],
    ["Schedule, channels, recipients, cooldown", "As for every alert", "Inherited"],
])
h2("Alert recipients: email, SMS, WhatsApp and push lists")
p("Who receives each alert is configured per alert type, per channel, at any level (company, branch, group, vehicle).")
h3("Company default lists (Settings → Notifications)")
table(["List", "Example"], [
    ["Default email list", "ops@abclogistics.in, owner@abclogistics.in"],
    ["Default SMS numbers", "+91 98400 12345, +91 94440 67890"],
    ["Default WhatsApp numbers", "+91 98400 12345"],
    ["Default push users", "All Admins"],
])
h3("Per-alert recipient settings")
table(["Channel", "Mode", "Recipients (example: Fuel theft, Chennai branch)"], [
    ["Email", "Default + additional", "Default list + accounts@abclogistics.in"],
    ["SMS", "Only this list", "+91 98400 12345 (owner), Branch Manager (dynamic)"],
    ["WhatsApp", "Use default list", "—"],
    ["Push", "Default + additional", "Default push users + current driver's supervisor"],
])
ul([
    "<b>Modes per channel:</b> Use default list · Default + additional · Only this list · None.",
    "<b>Recipient types:</b> named users, roles (e.g. all Branch Managers), dynamic contacts (users assigned to the vehicle, current driver, branch manager), contact groups, or typed emails/mobile numbers for people without a login.",
    "<b>Severity routing:</b> each severity tier can use different channels, e.g. Warning → email only; Critical → email + SMS + WhatsApp.",
    "<b>Inheritance:</b> lists follow the same Company → Branch → Group → Vehicle inheritance as other alert settings.",
    "<b>Scope safety:</b> users and roles only receive alerts for objects they are allowed to see; typed external contacts receive exactly what the admin configured.",
    "<b>Validation and cost control:</b> email and +91 mobile validation, duplicates removed, optional OTP verification for external numbers, SMS/WhatsApp usage estimate and plan limits shown before saving.",
    "<b>Send test</b> checks every list; the delivery log shows sent / delivered / failed per recipient.",
])
h2("Message templates")
p("All notification text is template-driven and can be viewed and edited in <b>Settings → Message templates</b> "
  "(Super Admin for system defaults, company Admin for the company's own versions).")
table(["Channel", "What can be edited", "Approval needed"], [
    ["Email", "Subject and full body (rich text/HTML), logo, colours, footer, placeholders", "None — changes apply immediately"],
    ["Push", "Title, body, sound, priority", "None"],
    ["SMS", "Choice of template per alert, variable mapping; new wording via request", "<b>Yes — TRAI DLT.</b> Text must match a DLT-registered template exactly"],
    ["WhatsApp", "Choice of template per alert, variable mapping; new wording via request", "<b>Yes — Meta</b> template approval"],
])
h3("Example: Overspeed")
table(["Channel", "Template"], [
    ["Email subject", "<code>[{{severity}}] Overspeed: {{vehicle_name}} at {{speed}} km/h</code>"],
    ["Email body", "<code>{{vehicle_name}} ({{plate}}) was driving at {{speed}} km/h (limit {{limit}}) near {{location}} at {{time}}. Driver: {{driver_name}}. View on map: {{map_link}}</code>"],
    ["SMS (DLT)", "<code>VeeTracer Alert: {#var#} overspeed {#var#} km/h at {#var#} on {#var#}. Track: {#var#}</code> → mapped to vehicle_name, speed, location, time, map_link"],
    ["Push", "<code>Overspeed · {{vehicle_name}}</code> / <code>{{speed}} km/h near {{location}}</code>"],
])
h3("Template Master page")
p("<b>Settings → Message templates</b> opens the Template Master: a single list of every template the user may see.")
table(["Name", "Purpose", "Channel", "Level", "Status", "DLT / Meta ID", "Used by", "Last changed"], [
    ["Overspeed – Email", "Alert: Overspeed", "Email", "Company", "Active", "—", "12 rules", "Priya, 14 Oct"],
    ["Overspeed – SMS", "Alert: Overspeed", "SMS", "System", "Approved", "1107169…", "8 rules", "Super Admin, 2 Oct"],
    ["Fuel theft – WhatsApp", "Alert: Fuel theft", "WhatsApp", "System", "Pending", "fuel_theft_v2", "0", "Super Admin, 16 Oct"],
    ["Geofence exit – Push", "Alert: Geofence exit", "Push", "System", "Active", "—", "21 rules", "Super Admin, 1 Oct"],
    ["Login OTP – SMS", "System: OTP", "SMS", "System", "Approved", "1107169…", "All logins", "Super Admin, 1 Oct"],
    ["Monthly report – Email", "System: Scheduled report", "Email", "Company", "Draft", "—", "3 schedules", "Ravi, 17 Oct"],
])
ul([
    "<b>Filters and search:</b> channel, alert type / system message, level (system/company), status (draft, active, pending approval, approved, rejected, inactive), language, \"overridden by my company\", \"not approved\".",
    "<b>Row actions:</b> view, edit, preview, send test, duplicate, version history, reset to default, activate/deactivate.",
    "<b>Company Admin view:</b> system defaults and the company's own overrides, with a badge showing which are overridden.",
    "<b>Super Admin view:</b> all system templates, how many companies override each one (drill down to the list), and every pending DLT/Meta approval.",
    "<b>Export</b> to Excel/CSV, e.g. to prepare the DLT registration batch.",
])
h3("SMS DLT workflow")
raw('<div class="flow"><span>Draft text</span>→<span>Register on DLT portal</span>→<span>Enter DLT template ID + sender ID</span>→<span class="ok">Approved — selectable per alert</span></div>')
ul([
    "VeeTracer registers a standard set of SMS templates for all alert types before launch, so companies can use SMS from day one.",
    "A company that wants different SMS wording raises a request from the template screen; once registered on DLT, the template becomes available to them.",
    "Templates under a white-label partner's own DLT registration are managed by the partner (P4).",
])
h2("Evaluation")
ul([
    "Rules are compiled per object and held in memory by the rules engine; changes are pushed instantly.",
    "Previous state (inside/outside each geofence, over speed limit, ignition, status) lives in memory and Valkey, so each check is a constant-time comparison.",
    "Time-based alerts (offline, idling too long, stayed too long, trip not started, late at stop, document expiry) run on a scheduler.",
    "Anti-flapping on geofences and status changes: minimum dwell and boundary buffer.",
    "Notification sending is asynchronous with retries; failures never delay other alerts.",
    "SMS/WhatsApp usage is metered per company against plan allowance and credit packs.",
])

# ---------------------------------------------------------------------------
h1("Master pages")
p("Every master in VeeTracer has its own master page built on one standard pattern, so all lists look and behave the same "
  "on web (and in a compact form on mobile). Visibility and actions follow the user's role permissions and data scope.")
h2("Standard behaviour of every master page")
features("MST", [
    ("List view with search, filters, sorting and pagination (server-side, fast at 10,000+ rows)", "P1"),
    ("Column chooser and saved filter views per user", "P1"),
    ("Add, view, edit, delete — buttons shown only if the role has that permission", "P1"),
    ("Active / Inactive status instead of hard delete where history depends on the record", "P1"),
    ("Delete protection: records in use (e.g. a route with trips) can only be deactivated", "P1"),
    ("Bulk actions: activate, deactivate, delete, assign branch/group", "P1"),
    ("Excel/CSV import with template download, row-level validation and error report", "P2"),
    ("Excel/CSV/PDF export of the current filtered list", "P1"),
    ("Record history: who created/changed what and when (from the audit log)", "P1"),
    ("Custom fields shown as extra columns and filters where the company has defined them", "P1"),
    ("Detail page with related records (e.g. a driver's vehicles, trips, alerts)", "P1"),
    ("Data scope respected: Managers and Users only see records in their branches/objects", "P1"),
])
h2("Master catalogue")
table(["Area", "Master page", "Managed by", "Phase"], [
    ["Platform", "Companies (customers)", "Super Admin", badge("P1")],
    ["Platform", "Partners (white-label)", "Super Admin", badge("P4")],
    ["Platform", "Plans &amp; pricing, Coupons", "Super Admin", badge("P1") + " / " + badge("P2")],
    ["Platform", "Device models &amp; capabilities", "Super Admin", badge("P1")],
    ["Platform", "Device inventory, SIM inventory", "Super Admin", badge("P1")],
    ["Platform", "Command catalogue", "Super Admin", badge("P1")],
    ["Platform", "Message templates (Template Master)", "Super Admin / Company Admin", badge("P1")],
    ["Platform", "Alert types catalogue", "Super Admin", badge("P1")],
    ["Organisation", "Branches", "Company Admin", badge("P1")],
    ["Organisation", "Users", "Admin / Manager", badge("P1")],
    ["Organisation", "Roles &amp; menu permissions", "Company Admin", badge("P1")],
    ["Organisation", "Contact groups", "Admin / Manager", badge("P2")],
    ["Organisation", "Custom fields", "Company Admin", badge("P1")],
    ["Assets", "Vehicles / tracked objects", "Admin / Manager", badge("P1")],
    ["Assets", "Devices (company view), SIMs", "Admin", badge("P1")],
    ["Assets", "Vehicle groups", "Admin / Manager", badge("P1")],
    ["Drivers", "Drivers (with licence, badge, documents)", "Admin / Manager", badge("P1")],
    ["Routes &amp; trips", "Routes, Stops / Points of interest", "Admin / Manager", badge("P1")],
    ["Routes &amp; trips", "Trip schedules", "Admin / Manager", badge("P1")],
    ["Geofences", "Geofences", "Admin / Manager", badge("P1")],
    ["Alerts", "Alert settings (by level), Alert templates (packs), Snoozes", "Admin / Manager", badge("P1")],
    ["Alerts", "Recipient lists, Default recipient lists", "Admin", badge("P1")],
    ["Passengers", "Students, Guardians, Employees", "Admin / Manager", badge("P2")],
    ["Passengers", "Shifts", "Admin", badge("P2")],
    ["Fuel", "Fuel tanks &amp; calibration tables", "Admin", badge("P2")],
    ["Maintenance", "Service schedules, Vehicle documents", "Admin / Manager", badge("P2")],
    ["Reports", "Report schedules", "Any user (own) / Admin (all)", badge("P1")],
    ["Integrations", "API keys, Webhooks, Forwarding targets", "Admin", badge("P1") + " / " + badge("P2")],
])
h2("Lookup masters (dropdown values)")
p("Small reference lists used in dropdowns. VeeTracer ships system values (Super Admin); companies can add their own where marked.")
table(["Lookup", "Examples", "Company can add"], [
    ["Object types &amp; vehicle types", "Car, Bike, Truck, Bus, School bus, Van, Person, Pet, Asset", "Vehicle sub-types"],
    ["Vehicle makes &amp; models", "Tata, Ashok Leyland, Mahindra, Maruti, Hero, TVS…", "Yes"],
    ["Fuel types", "Petrol, Diesel, CNG, EV", "No"],
    ["Licence classes", "MCWG, LMV, LMV-TR, HMV, HGMV, HPMV, Transport", "No"],
    ["Document types", "Insurance, Permit, Fitness, PUC, RC, Licence, Badge", "Yes"],
    ["Geofence / POI categories", "Home, Office, Depot, Customer, School, Parking, Fuel station, No-go", "Yes"],
    ["Alert priorities", "Info, Warning, Critical", "No"],
    ["Departments, designations", "—", "Yes"],
    ["Classes / sections, campuses", "—", "Yes"],
    ["Timezones, units, languages", "Asia/Kolkata, km / mi, English", "No"],
])
h1("Apps, roles and animations")
h2("Which app shows what")
table(["Role", "App", "Home screen", "Main menus"], [
    ["Super Admin", "Web, Admin app", "Platform dashboard", "Customers, devices, plans, catalogue, templates, health"],
    ["Company Admin / Manager", "Web, Admin app", "Fleet dashboard", "Live map, vehicles, drivers, routes &amp; trips, geofences, alerts, reports, masters, users"],
    ["User / Viewer", "Web, VeeTracer app", "Fleet dashboard (own scope)", "Live map, vehicles, history, alerts, reports (as permitted)"],
    ["Individual", "Web, VeeTracer app", "My Vehicles", "Live map, history, my rides, alerts, geofences, family"],
    ["Driver", "VeeTracer app", "Today's duty &amp; trip", "Trip, stops, SOS, inspection, fuel entry, my score, documents"],
    ["Attendant", "VeeTracer app", "Today's trip passengers", "Passenger list, attendance, SOS"],
    ["Employee (passenger)", "VeeTracer app", "My cab today", "Track my cab, ETA, boarding, SOS, roster, history"],
    ["Delivery staff", "VeeTracer app", "Duty on/off", "Duty, my location, SOS"],
    ["Parent", "Parent app", "My children", "Bus live, ETA, boarding status, trip history"],
])
p("Menus are never hard-coded per app: each app requests the user's permissions at login and builds its menu from the menu-role mapping, "
  "so a new custom role works in the apps without an app update.")

h2("Design system and themes")
features("UI", [
    ("Web UI built with Tailwind CSS; accessible components from shadcn/ui (Radix), owned in our codebase", "P1"),
    ("Light, Dark and System (follow device) themes on web and all mobile apps", "P1"),
    ("Theme choice saved per user and synced across web and mobile", "P1"),
    ("Shared design tokens (colours, spacing, radius, typography) used by Tailwind config and Flutter ThemeData, so web and apps look the same", "P1"),
    ("Status colours (running, idle, off, overspeed, offline) and alert priorities tuned for contrast in both themes", "P1"),
    ("Light and dark map styles from our own OSM tiles; map switches with the app theme (or user can lock map to light)", "P1"),
    ("Charts, tables, dialogs and playback controls fully themed", "P1"),
    ("Responsive layouts: desktop, tablet and mobile web", "P1"),
    ("Accessibility: WCAG AA contrast in both themes, keyboard navigation, visible focus, 'reduce motion'", "P1"),
    ("White-label partners override brand tokens (logo, primary colour) without code changes", "P4"),
])
table(["Item", "Light", "Dark"], [
    ["Web app, Admin app, VeeTracer app, Parent app", "Yes", "Yes"],
    ["Map tiles", "Light style", "Dark style"],
    ["Emails", "Light (email clients handle dark mode inconsistently)", "Auto-adapted by the email client"],
    ["PDF / Excel reports, invoices", "Always light (print-friendly)", "—"],
])
h2("Animations and trip playback")
features("ANI", [
    ("Trip playback animation everywhere a trip appears (history, trip details, driver/employee/parent trip history, alerts, reports)", "P1"),
    ("Playback controls: play/pause, 1×–16× speed, scrubber, jump to stop/alert, follow-camera on/off", "P1"),
    ("Path drawn progressively behind the moving marker, coloured by speed or status (running/idle/overspeed)", "P1"),
    ("Marker rotates smoothly with heading; vehicle-type icon (car, bike, bus, truck, person, pet)", "P1"),
    ("Live data panel during playback: time, speed, ignition, AC, fuel, address, driver; speed graph cursor in sync", "P1"),
    ("Stops and alerts pop in on the map as playback passes them", "P1"),
    ("Planned route shown as dashed line with actual path animating over it (route trips)", "P1"),
    ("Live map: markers glide smoothly between updates (interpolated position and bearing) instead of jumping", "P1"),
    ("Follow mode with smooth camera pan and auto-zoom by speed", "P1"),
    ("Trip cards with a 'mini replay' preview animation on tap", "P2"),
    ("Parent/employee view: bus/cab moving along the route line towards 'my stop' with animated ETA progress", "P2"),
    ("Geofence entry/exit ripple, stop-arrival pulse, new-alert slide-in with sound", "P1"),
    ("Status colour transitions, animated dashboard counters and charts, skeleton loaders, smooth page transitions", "P1"),
    ("Export trip replay as a shareable video/GIF", "P4"),
    ("Performance guard: GPU map rendering (MapLibre); marker animation only for objects in view and below a count limit; 'reduce motion' and battery-saver settings respected", "P1"),
])
note("Trip playback runs entirely on the device from the downloaded track (simplified for long trips), so it stays smooth at 60 fps "
     "and puts no load on the server while playing.", "ok")
h1("Live map, history and trips")
h2("Live map")
ul([
    "On open, the client loads the current state of every object in scope from Valkey (fast snapshot), then receives only changes.",
    "The server knows each viewer's scope and current map area; updates outside them aren't sent.",
    "Updates are batched about once per second per viewer, and markers are animated between points.",
    "At 10,000 objects the web map uses clustering and WebGL rendering (MapLibre) to stay smooth.",
])
h2("Automatic trips vs planned trips")
table(["", "Automatic trip", "Planned (route) trip"], [
    ["Created by", "System, from ignition/movement", "User/schedule: Driver + Vehicle + Route + time"],
    ["Who uses it", "Everyone, including Individuals", "Business accounts with routes"],
    ["Ends when", "Stop longer than 5 min (configurable)", "Arrival at final stop or manual close"],
    ["Extra data", "—", "Planned vs actual per stop, delays, passengers, on-time %"],
])
h2("Planned trip states")
raw('<div class="flow"><span>Scheduled</span>→<span>Started</span>→<span>In progress</span>→<span class="ok">Completed</span> / <span class="warn">Incomplete</span> / <span class="bad">Cancelled</span></div>')

# ---------------------------------------------------------------------------
h1("Reports")
table(["Report", "Contents", "Phase"], [
    ["Summary (day / week / month)", "Distance, running, idle, stop, offline time, trips, max/avg speed, overspeed count, first start, last stop, engine hours, fuel", badge("P1")],
    ["Trips", "Automatic and planned trips with details", badge("P1")],
    ["Stops / idle", "Location, start, duration", badge("P1")],
    ["Alerts", "All alerts with acknowledgement details", badge("P1")],
    ["Trip performance", "On-time %, stop delays, planned vs actual km by route/driver/vehicle", badge("P1")],
    ["Geofence visits", "In, out, duration, violations", badge("P2")],
    ["Ignition / AC / engine hours", "On/off times and durations", badge("P2")],
    ["Overspeed", "Events with peak speed, duration, location", badge("P2")],
    ["Utilisation", "Running vs available time per vehicle", badge("P2")],
    ["Fuel", "Consumption, km/L, refuels, theft", badge("P2")],
    ["Driver score", "Score, events, ranking", badge("P2")],
    ["Attendance", "Boarding/drop logs, absentees, occupancy", badge("P2")],
])
p("Daily summaries are maintained continuously per object, so weekly and monthly reports for a whole fleet are "
  "sums over stored daily rows rather than scans of raw positions.")

# ---------------------------------------------------------------------------
h1("Passenger module and Parent app")
ul([
    "Students and employees are mapped to a vehicle, route, pickup stop and drop stop (separately for morning and evening).",
    "Each planned trip carries the passenger list per stop.",
    "Attendance per company: Off, RFID, in-app, or both. RFID taps and attendant marks merge into one record.",
    "Parent app login by mobile OTP, matched to the guardian phone in the student profile.",
    "Parents see only their own children: profile, assigned bus, live location during trip hours, ETA, boarded/dropped status, trip history.",
    "Parent and employee notifications: bus started, approaching stop, boarded, dropped, delayed.",
    "Built behind a module switch so it can be included in plans or sold as an add-on later.",
])

# ---------------------------------------------------------------------------
h1("Video and cameras")
ul([
    "Devices stream to ZLMediaKit, which converts JT/T 1078, RTMP and RTSP into WebRTC (lowest delay), HTTP-FLV or HLS for web and mobile.",
    "Streams start only when someone opens them and stop automatically after a set time.",
    "Alarm clips and snapshots are stored in object storage, linked to alerts and the history timeline.",
    "Separate permissions for live view, playback and download; every view is logged.",
    "Each live stream needs ~0.5–1 Mbps on the server; 50 concurrent viewers ≈ 50 Mbps upload. The media server scales independently.",
])
note("Open item: the exact Concox/Jimi dashcam model must be confirmed. Some firmware uses JT808/1078, others only Jimi's own platform.", "warn")

# ---------------------------------------------------------------------------
h1("Maps (self-hosted OpenStreetMap)")
table(["Service", "Tool", "Resources (India)"], [
    ["Vector tiles", "Planetiler (build) + Martin (serve), MapLibre (display)", "~10 GB tiles, light CPU"],
    ["Reverse geocoding", "Nominatim (or Photon)", "~16–32 GB RAM, ~150–300 GB SSD"],
    ["Routing / ETA / snapping", "OSRM", "~8–16 GB RAM"],
])
ul([
    "Source data: India extract from Geofabrik (~1.5 GB), refreshed monthly.",
    "Address lookups cached by rounded coordinates to keep load low.",
    "No per-request map fees. Satellite imagery is the only map feature that would need a paid provider.",
])

# ---------------------------------------------------------------------------
h1("Billing and plans")
h2("Structure")
ul([
    "Separate plan families for Business and Individual accounts.",
    "Each plan has a monthly price and an annual price (proposed: annual = 10 × monthly, i.e. 2 months free).",
    "Limits per plan: devices, users, history days (≤ 180), geofences, SMS/WhatsApp allowance, video minutes, modules.",
    "Razorpay Subscriptions for auto-renewal; grace period then automatic suspension; reactivation on payment.",
    "GST-compliant invoices with CGST/SGST or IGST and customer GSTIN.",
])
h2("Illustrative plan grid (prices to be decided)")
table(["Plan", "Account", "Devices", "Users", "History", "Channels", "Monthly / Annual"], [
    ["Personal", "Individual", "1–2", "3 (family)", "30 days", "In-app, push, email", "₹ TBD"],
    ["Family", "Individual", "up to 5", "5", "60 days", "+ SMS allowance", "₹ TBD"],
    ["Starter", "Business", "up to 10", "5", "60 days", "In-app, push, email", "₹ TBD"],
    ["Business", "Business", "up to 100", "25", "90 days", "+ SMS, WhatsApp", "₹ TBD"],
    ["Enterprise", "Business", "custom", "custom", "180 days", "All + webhooks, API", "₹ TBD"],
])

# ---------------------------------------------------------------------------
h1("Security, compliance and India-specific requirements")
table(["Topic", "What VeeTracer does"], [
    ["DPDP Act 2023", "Consent capture for tracking people (delivery staff, employees, students via school), purpose limitation, data export/deletion on request, privacy policy"],
    ["Aadhaar", "Never store full number in clear; mask to last 4 digits; encrypted document storage"],
    ["AIS-140", "Certified device support, emergency alert handling, data forwarding to state backends; state-by-state requirements to be confirmed"],
    ["SMS (TRAI DLT)", "Register entity, sender IDs and templates before launch (takes weeks)"],
    ["WhatsApp", "Meta-approved templates via Cloud API or a BSP"],
    ["GST", "Invoices with GSTIN, place of supply, CGST/SGST/IGST"],
    ["Application security", "OWASP practices, parameterised queries, rate limiting, 2FA, audit log, secrets management, encrypted backups"],
    ["Data residency", "Hosting in India recommended for customer trust and regulatory comfort"],
])

# ---------------------------------------------------------------------------
h1("Infrastructure and running costs")
h2("Recommended servers")
table(["Role", "Launch (≤ 3,000 devices)", "Growth (~10,000 devices)"], [
    ["Application (gateways, API, realtime, workers, Valkey)", "1 × 8 vCPU, 16–32 GB RAM", "2–3 × 8 vCPU, 16 GB RAM"],
    ["Database (PostgreSQL + TimescaleDB)", "1 × 8 vCPU, 32 GB RAM, 1 TB NVMe", "1 × 16 vCPU, 64 GB RAM, 2 TB NVMe + 1 replica"],
    ["Maps (tiles, Nominatim, OSRM)", "Shared with app server or 1 × 4 vCPU, 32 GB", "1 × 8 vCPU, 32 GB RAM, 500 GB SSD"],
    ["Media server (P3)", "—", "1 × 8 vCPU, 16 GB RAM, 1 Gbps"],
    ["Object storage", "500 GB", "4–10 TB (video dependent)"],
    ["Backups", "Off-site daily", "Off-site daily + point-in-time recovery"],
])
h2("Running costs that can't be avoided")
table(["Item", "Indicative cost (verify current rates)"], [
    ["Servers", "Depends on provider (own hardware, Indian data centre, or cloud)"],
    ["Domain + TLS", "Domain ~₹1,000/year; TLS free (Let's Encrypt)"],
    ["SMS", "~₹0.15–0.30 per SMS + DLT registration"],
    ["WhatsApp", "Per-message template pricing set by Meta (utility messages are the cheapest category)"],
    ["Email", "~$0.10 per 1,000 (Amazon SES)"],
    ["Payments", "Razorpay ~2% per transaction"],
    ["App stores", "Google Play $25 one-time; Apple $99/year"],
    ["Cell-tower location", "OpenCelliD free; paid services optional for better coverage"],
])

# ---------------------------------------------------------------------------
h1("Non-functional requirements")
table(["Requirement", "Target"], [
    ["Live update latency (device → screen)", "&lt; 2 s at 95th percentile"],
    ["Alert latency", "In-app &lt; 2 s, push &lt; 5 s, SMS/WhatsApp/email &lt; 30 s"],
    ["Ingestion capacity", "1,000 positions/s sustained at 10,000 devices; burst 3× without loss"],
    ["Data durability", "No accepted position lost (durable stream + acknowledged writes)"],
    ["Availability", "99.9% monthly for API and live tracking"],
    ["Backups", "RPO ≤ 15 min (WAL archiving), RTO ≤ 4 h"],
    ["Report generation", "Monthly summary for 1,000 vehicles &lt; 10 s"],
    ["Web map", "Smooth with 10,000 markers (clustered)"],
    ["Mobile tracker battery", "&lt; 5% per hour on duty at default interval (target, device dependent)"],
    ["Retention", "Configurable 30–180 days per company; video separately"],
])

# ---------------------------------------------------------------------------
h1("Phased roadmap")
table(["Phase", "Goal", "Main contents"], [
    [badge("P1") + " Core platform", "Sell to the first customers",
     "Multi-tenant accounts (Business/Individual), roles &amp; branches, single Super Admin console, Concox GT06 + phone tracking, "
     "live map with statuses, history &amp; automatic trips, drivers, routes &amp; planned trips, geofences, core alerts (in-app/push/email), "
     "commands (engine cut-off), summary reports + scheduling, dashboards, Razorpay plans + GST invoices, self-hosted maps, "
     "web, VeeTracer Admin app, role-based VeeTracer app (users, individuals, drivers, delivery staff) with trip animations, REST API, load-tested for 10,000 devices"],
    [badge("P2") + " Operations", "Depth for fleets and schools",
     "AIS-140, Teltonika, Traccar gateway (other brands), OBD, watches, pet trackers; SMS/WhatsApp/webhooks; escalation; "
     "fuel monitoring; driver score; maintenance &amp; documents; passenger module + Parent app; more reports; OSRM routing; "
     "multi-screen tracking; share links"],
    [badge("P3") + " Video", "Camera-enabled fleets", "JT/T 808/1078 dashcams and MDVR, live video, playback, alarm clips, ADAS/DMS alerts"],
    [badge("P4") + " Growth", "Scale the business", "White-label partners and partner billing, ad-hoc tracking, satellite layer, Sarathi verification, Tamil/Hindi"],
])
note("Durations depend on team size and are deliberately not fixed here (own timeline). Each phase ends with a "
     "usable, releasable product.")
h2("Delivery plan (AI-assisted build)")
p("Planned with Claude writing most of the code, the product owner testing and deciding daily, and ideally one developer reviewing. "
  "Times are calendar estimates; they will be re-confirmed at the end of M1 based on measured progress.")
table(["Milestone", "Deliverable", "Estimate"], [
    ["<b>M1</b> Foundation (trial)", "Accounts, roles, masters framework, Concox GT06 gateway, device simulator, live map on web, light/dark theme", "2–3 weeks"],
    ["<b>M2</b> P1a — launchable core", "History and playback animation, geofences, core alerts, summary reports, Razorpay plans, Admin and role-based apps", "+6–8 weeks"],
    ["<b>M3</b> Full P1", "Drivers → routes → trips, alert levels, recipient lists, templates, scheduled reports, dashboards, driver app, 10k load test, production deployment", "+6–8 weeks"],
    ["P2", "Operations (see roadmap)", "~3–4 months"],
    ["P3", "Video", "~1.5–2 months"],
])
h3("Prerequisites")
ul([
    "M1: TimescaleDB and Valkey on the development machine (PostgreSQL 16 already installed); 1–2 Concox test devices with data SIMs.",
    "M2: a server or tunnel reachable by devices; Android test phone; Razorpay test account.",
    "M3: Xcode and Apple developer account, Google Play account, DLT-registered SMS templates, production server.",
])
h2("Phase 1 build order")
table(["Step", "Deliverable"], [
    ["1", "Foundations: repo, CI, Docker, database schema, auth (OTP + email/password), tenancy, roles &amp; scope"],
    ["2", "Device catalogue, devices/objects/assignments, Concox GT06 gateway, phone ingestion, stream + processor"],
    ["3", "Live state, realtime gateway, live map (web), statuses, vehicle info panel"],
    ["4", "History, automatic trips, daily summaries, data-quality filters"],
    ["5", "Geofences + rules engine + notifications (in-app, push, email) + alert panel"],
    ["6", "Drivers, routes, planned trips, trip alerts and reports"],
    ["7", "Reports and scheduling, dashboards, commands"],
    ["8", "Billing (Razorpay, GST invoices), Super Admin console"],
    ["9", "Flutter apps: VeeTracer Admin, role-based VeeTracer app (viewer, individual, driver, tracker mode), trip playback animations"],
    ["10", "Self-hosted maps, 10,000-device load test, security review, production deployment"],
])

# ---------------------------------------------------------------------------
h1("Open decisions")
table(["#", "Decision", "Needed by"], [
    ["1", "Exact Concox/Jimi dashcam model(s) and their protocol (JT808/1078 or proprietary)", "Before P3"],
    ["2", "AIS-140: which states, and which Concox (or other) models are certified", "Before P2"],
    ["3", "Plan prices (monthly/annual) for Business and Individual plans", "Before P1 launch"],
    ["4", "Passenger module pricing: included or paid add-on", "Before P2 launch"],
    ["5", "Hosting provider / own hardware and data-centre location (India recommended)", "During P1"],
    ["6", "SMS provider (DLT registration), WhatsApp provider, email provider", "Start DLT early in P1"],
    ["7", "Google Play and Apple developer accounts in the company name", "During P1"],
    ["8", "Satellite imagery provider (optional, paid)", "P4"],
    ["9", "Legal: terms of service, privacy policy, DPDP consent wording, data processing agreement", "Before P1 launch"],
    ["10", "Brand assets: logo, colours, app icons for VeeTracer", "During P1"],
])

# ---------------------------------------------------------------------------
h1("Glossary")
table(["Term", "Meaning"], [
    ["AIS-140", "Indian standard for vehicle tracking devices in public/commercial transport"],
    ["DLT", "TRAI's Distributed Ledger registration required for commercial SMS in India"],
    ["DPDP Act", "Digital Personal Data Protection Act, 2023 (India)"],
    ["GT06", "The protocol used by most Concox GPS trackers"],
    ["JT/T 808 / 1078", "Chinese standards for vehicle terminals (tracking/alarms) and video streaming, used by most dashcams and MDVRs"],
    ["LBS", "Location from mobile cell towers (approximate)"],
    ["MDVR", "Mobile digital video recorder with several cameras (buses, trucks)"],
    ["OBD", "On-board diagnostics port; OBD trackers read engine data"],
    ["OSM", "OpenStreetMap, the free, open map data source"],
    ["Hot path", "The processing chain that must be fast: incoming position → live map and alerts"],
    ["Hypertable", "TimescaleDB's automatically partitioned table for time-series data"],
    ["Capability", "A feature a device model supports (ignition, AC, fuel, camera…), driving what the UI and alerts offer"],
])

# ---------------------------------------------------------------------------
CSS = """
@page { size: A4; margin: 18mm 16mm 18mm 16mm;
  @bottom-left { content: "VeeTracer — Product & System Design"; font: 8pt 'Helvetica Neue', Arial, sans-serif; color: #6b7280; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt 'Helvetica Neue', Arial, sans-serif; color: #6b7280; } }
@page :first { margin: 0; @bottom-left { content: none } @bottom-right { content: none } }
* { box-sizing: border-box; }
body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 9.6pt; line-height: 1.45; color: #1f2937; margin: 0; }
.cover { height: 297mm; padding: 38mm 22mm; background: linear-gradient(160deg, #0b3b5a 0%, #0f5c7a 55%, #14866d 100%); color: #fff; position: relative; page-break-after: always; }
.cover .logo { font-size: 13pt; letter-spacing: .3em; text-transform: uppercase; opacity: .85; }
.cover h1 { font-size: 40pt; margin: 22mm 0 4mm; border: 0; padding: 0; color: #fff; page-break-before: avoid; }
.cover .sub { font-size: 16pt; opacity: .95; }
.cover .meta { position: absolute; bottom: 30mm; left: 22mm; font-size: 10.5pt; line-height: 1.9; }
.cover .meta b { display: inline-block; width: 34mm; font-weight: 600; opacity: .8; }
.cover .pin { position: absolute; right: 26mm; top: 150mm; width: 50mm; height: 50mm; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); border: 3mm solid rgba(255,255,255,.85); }
.cover .pin:after { content: ''; position: absolute; width: 18mm; height: 18mm; border-radius: 50%; background: rgba(255,255,255,.85); left: 13mm; top: 13mm; }
h1 { font-size: 18pt; color: #0b3b5a; border-bottom: 2px solid #14866d; padding-bottom: 2mm; margin: 0 0 4mm; page-break-before: always; }
h1 .num { display: inline-block; min-width: 10mm; color: #14866d; }
h2 { font-size: 12.5pt; color: #0f5c7a; margin: 6mm 0 2mm; page-break-after: avoid; }
h3 { font-size: 10.5pt; color: #374151; margin: 4mm 0 2mm; page-break-after: avoid; }
p { margin: 0 0 2.5mm; }
ul { margin: 0 0 3mm; padding-left: 5mm; } li { margin-bottom: 1mm; }
table { width: 100%; border-collapse: collapse; margin: 1mm 0 4mm; font-size: 8.8pt; page-break-inside: auto; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th { background: #0b3b5a; color: #fff; text-align: left; padding: 1.6mm 2mm; font-weight: 600; }
td { padding: 1.4mm 2mm; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
tbody tr:nth-child(even) td { background: #f6f8fa; }
table.feat td:first-child { width: 17mm; white-space: nowrap; }
table.feat td:last-child { width: 13mm; text-align: center; }
.fid { font-family: Menlo, monospace; font-size: 8pt; color: #0f5c7a; font-weight: 600; }
.ph { display: inline-block; padding: .2mm 1.6mm; border-radius: 2mm; font-size: 7.6pt; font-weight: 700; color: #fff; }
.ph1 { background: #14866d; } .ph2 { background: #2563eb; } .ph3 { background: #9333ea; } .ph4 { background: #d97706; }
.callout { border-left: 3px solid #2563eb; background: #eff6ff; padding: 2.5mm 3.5mm; margin: 2mm 0 4mm; border-radius: 1mm; }
.callout.ok { border-color: #14866d; background: #ecfdf5; } .callout.warn { border-color: #d97706; background: #fffbeb; }
.dot { display: inline-block; width: 3mm; height: 3mm; border-radius: 50%; vertical-align: middle; margin-right: 1mm; }
code { font-family: Menlo, monospace; font-size: 8.4pt; background: #f3f4f6; padding: 0 1mm; border-radius: 1mm; }
.toc { columns: 2; column-gap: 10mm; margin-top: 2mm; } .toc div { padding: .8mm 0; border-bottom: 1px dotted #d1d5db; break-inside: avoid; }
.toc span { display: inline-block; width: 8mm; color: #14866d; font-weight: 700; }
.tree { margin: 2mm 0 4mm; } .tree .branch { margin-left: 8mm; border-left: 2px solid #14866d; padding-left: 4mm; }
.tree .node { display: inline-block; background: #f0fdf9; border: 1px solid #14866d; border-radius: 1.5mm; padding: 1.5mm 3mm; margin: 1.5mm 0; font-weight: 600; color: #0b3b5a; }
.tree .node small { font-weight: 400; color: #4b5563; } .tree .root { background: #0b3b5a; color: #fff; } .tree .root small { color: #cbd5e1; }
.arch { border: 1px solid #e5e7eb; border-radius: 2mm; padding: 3mm; page-break-inside: avoid; }
.arch .layer { display: flex; gap: 2mm; align-items: stretch; }
.arch .lbl { width: 20mm; flex: none; font-size: 7.6pt; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; display: flex; align-items: center; font-weight: 700; }
.arch .box { flex: 1; background: #f3f6f9; border: 1px solid #cbd5e1; border-radius: 1.5mm; padding: 1.6mm; font-size: 8pt; text-align: center; font-weight: 600; color: #0b3b5a; }
.arch .box small { font-weight: 400; color: #4b5563; font-size: 7.2pt; } .arch .box.wide { flex: 4; }
.arch .box.hot { background: #ecfdf5; border-color: #14866d; }
.arch .arrow { text-align: center; color: #14866d; font-size: 9pt; line-height: 1.1; margin: .6mm 0 .6mm 20mm; }
.legend { font-size: 8pt; color: #4b5563; } .hotkey { display: inline-block; width: 3mm; height: 3mm; background: #ecfdf5; border: 1px solid #14866d; vertical-align: middle; }
.flow { font-weight: 600; color: #374151; margin: 2mm 0 4mm; } .flow span { display: inline-block; padding: 1.2mm 2.5mm; margin: 0 1mm; border-radius: 1.5mm; background: #e0f2fe; color: #0b3b5a; }
.flow .ok { background: #dcfce7; } .flow .warn { background: #fef3c7; } .flow .bad { background: #fee2e2; }
.total { font-size: 11pt; font-weight: 700; color: #0b3b5a; background: #ecfdf5; border: 1px solid #14866d; padding: 3mm; border-radius: 1.5mm; }
"""

cover = f"""
<section class="cover">
  <div class="logo">VeeTracer</div>
  <div class="pin"></div>
  <h1>Product &amp; System<br>Design Document</h1>
  <div class="sub">GPS tracking SaaS — Web, Mobile and Parent apps</div>
  <div class="meta">
    <div><b>Version</b>{VERSION}</div>
    <div><b>Date</b>{DATE}</div>
    <div><b>Status</b>Approved — development baseline</div>
    <div><b>Scope</b>Product requirements, architecture, data model, roadmap</div>
  </div>
</section>
"""

body = "\n".join(parts)
toc_html = '<div class="toc">' + "".join(f"<div><span>{n}</span>{t}</div>" for n, t in toc) + "</div>"
body = body.replace("<!--TOC-->", toc_html)
body = body.replace("<!--OPEN_SEC-->", str(next(n for n, t in toc if t == "Open decisions")))
body = body.replace("<!--FEATURE_TOTAL-->",
                    f'<div class="total">Total: {FEATURE_COUNT["n"]} features across {len(FEATURE_COUNT["modules"])} modules.</div>')

doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>VeeTracer Design Document</title><style>{CSS}</style></head>
<body>{cover}{body}</body></html>"""
OUT_HTML.write_text(doc, encoding="utf-8")

subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                f"--print-to-pdf={OUT_PDF}", OUT_HTML.as_uri()], check=True,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(f"features={FEATURE_COUNT['n']}  html={OUT_HTML}  pdf={OUT_PDF}")
