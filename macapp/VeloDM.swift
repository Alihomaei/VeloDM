// VeloDM for macOS: native download manager window + menu bar item.
// Talks to the VeloDM engine daemon over its Unix socket (newline JSON),
// the same engine the Chrome extension uses, so both show the same list.
import AppKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Model

struct Job: Identifiable, Equatable {
    var id: String
    var kind: String
    var url: String
    var page: String
    var filename: String
    var title: String
    var path: String
    var status: String
    var stage: String
    var size: Double
    var done: Double
    var speed: Double
    var eta: Double?
    var error: String
    var created: Double
    var finished: Double
    var connections: Int
    var parts: [[Double]]

    init(_ d: [String: Any]) {
        func s(_ k: String) -> String { d[k] as? String ?? "" }
        func n(_ k: String) -> Double { (d[k] as? NSNumber)?.doubleValue ?? 0 }
        id = s("id"); kind = s("kind"); url = s("url"); page = s("page")
        filename = s("filename"); title = s("title"); path = s("path")
        status = s("status"); stage = s("stage"); error = s("error")
        size = n("size"); done = n("done"); speed = n("speed")
        eta = (d["eta"] as? NSNumber)?.doubleValue
        created = n("created"); finished = n("finished")
        connections = (d["connections"] as? NSNumber)?.intValue ?? 0
        parts = (d["parts"] as? [[NSNumber]])?.map { $0.map(\.doubleValue) } ?? []
    }

    var name: String { !filename.isEmpty ? filename : !title.isEmpty ? title : url }
    var progress: Double { size > 0 ? min(1, done / size) : (status == "done" ? 1 : 0) }
    var isActive: Bool { status == "downloading" || status == "queued" }
    var category: String {
        let ext = (name as NSString).pathExtension.lowercased()
        if ["mp4", "mkv", "webm", "mov", "avi", "flv", "m4v", "ts"].contains(ext) || kind == "ytdlp" && ext != "mp3" { return "Video" }
        if ["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus"].contains(ext) { return "Music" }
        if ["zip", "rar", "7z", "gz", "tgz", "bz2", "xz", "tar", "dmg", "iso"].contains(ext) { return "Compressed" }
        if ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "epub"].contains(ext) { return "Documents" }
        if ["pkg", "exe", "msi", "apk", "app", "deb"].contains(ext) { return "Programs" }
        return "Other"
    }
}

struct EngineSettings: Equatable {
    var downloadDir = "~/Downloads"
    var connections = 8
    var maxActive = 3
    var speedLimitKB = 0
    var categorize = true
}

// MARK: - Engine connection

final class EngineClient: ObservableObject {
    @Published var jobs: [Job] = []
    @Published var connected = false
    @Published var lastError = ""
    @Published var settings = EngineSettings()
    @Published var hasYtdlp = true

    private var fd: Int32 = -1
    private var rid = 0
    private var pending: [Int: ([String: Any]) -> Void] = [:]
    private let ioQueue = DispatchQueue(label: "velodm.io")
    private let writeLock = NSLock()

    static let stateDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/VeloDM")
    static let sockPath = stateDir.appendingPathComponent("engine.sock").path
    static let engineLauncher = stateDir.appendingPathComponent("velodm-engine").path

    init() { start() }

    func start() {
        ioQueue.async { [weak self] in self?.runLoop() }
    }

    private func openSocket() -> Int32 {
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return -1 }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let path = Array(Self.sockPath.utf8CString)
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            for (i, c) in path.prefix(buf.count - 1).enumerated() { buf[i] = UInt8(bitPattern: c) }
        }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if ok != 0 { close(s); return -1 }
        return s
    }

    private func launchEngine() {
        guard FileManager.default.isExecutableFile(atPath: Self.engineLauncher) else {
            DispatchQueue.main.async { self.lastError = "Engine not installed. Run install.sh in the velodm folder." }
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: Self.engineLauncher)
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    private func runLoop() {
        var lastLaunch = Date.distantPast
        while true {
            fd = openSocket()
            if fd < 0 {
                // (re)start the engine, at most every 5 s while it's unreachable
                if Date().timeIntervalSince(lastLaunch) > 5 { launchEngine(); lastLaunch = Date() }
                DispatchQueue.main.async { self.connected = false }
                Thread.sleep(forTimeInterval: 0.5)
                continue
            }
            DispatchQueue.main.async {
                self.connected = true
                self.lastError = ""
                self.request(["cmd": "hello"]) { r in
                    if let s = r["settings"] as? [String: Any] { self.applySettings(s) }
                    self.hasYtdlp = (r["ytdlp"] as? Bool) ?? true
                }
            }
            var buf = Data()
            var chunk = [UInt8](repeating: 0, count: 65536)
            while true {
                let n = read(fd, &chunk, chunk.count)
                if n <= 0 { break }
                buf.append(chunk, count: n)
                while let nl = buf.firstIndex(of: 0x0A) {
                    let line = buf.subdata(in: buf.startIndex..<nl)
                    buf.removeSubrange(buf.startIndex...nl)
                    if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                        DispatchQueue.main.async { self.handle(obj) }
                    }
                }
            }
            close(fd)
            fd = -1
            DispatchQueue.main.async { self.connected = false }
            Thread.sleep(forTimeInterval: 1)
        }
    }

    private func handle(_ m: [String: Any]) {
        switch m["type"] as? String {
        case "jobs":
            let list = (m["jobs"] as? [[String: Any]] ?? []).map(Job.init)
            if list != jobs { jobs = list }
            updateDockBadge()
        case "reply":
            if let r = (m["rid"] as? NSNumber)?.intValue, let cb = pending.removeValue(forKey: r) { cb(m) }
        case "finished":
            if let j = m["job"] as? [String: Any] { NSApp.requestUserAttention(.informationalRequest); _ = j }
        default: break
        }
    }

    func request(_ payload: [String: Any], _ cb: (([String: Any]) -> Void)? = nil) {
        rid += 1
        var p = payload
        p["rid"] = rid
        if let cb { pending[rid] = cb }
        guard var data = try? JSONSerialization.data(withJSONObject: p) else { return }
        data.append(0x0A)
        let f = fd
        writeLock.lock()
        defer { writeLock.unlock() }
        guard f >= 0 else { lastError = "Not connected to engine"; return }
        data.withUnsafeBytes { raw in
            var off = 0
            while off < raw.count {
                let w = write(f, raw.baseAddress!.advanced(by: off), raw.count - off)
                if w <= 0 { break }
                off += w
            }
        }
    }

    // actions
    func act(_ cmd: String, _ job: Job, extra: [String: Any] = [:]) {
        var p: [String: Any] = ["cmd": cmd, "id": job.id]
        p.merge(extra) { $1 }
        request(p)
    }
    func all(_ cmd: String) { request(["cmd": cmd]) }

    func add(url: String, filename: String?, engine: String, format: String? = nil, audioOnly: Bool = false) {
        var p: [String: Any] = ["cmd": "download", "url": url, "engine": engine, "page": url]
        if let filename, !filename.isEmpty { p["filename"] = filename }
        if let format { p["format"] = format }
        if audioOnly { p["audioOnly"] = true }
        request(p)
    }

    func probe(_ url: String, _ cb: @escaping ([String: Any]) -> Void) {
        request(["cmd": "probe", "url": url], cb)
    }

    func saveSettings(_ s: EngineSettings) {
        request(["cmd": "settings", "set": [
            "downloadDir": s.downloadDir, "connections": s.connections, "maxActive": s.maxActive,
            "speedLimit": s.speedLimitKB * 1024, "categorize": s.categorize,
        ]]) { r in
            if let s = r["settings"] as? [String: Any] { self.applySettings(s) }
        }
    }

    private func applySettings(_ d: [String: Any]) {
        var s = EngineSettings()
        s.downloadDir = d["downloadDir"] as? String ?? s.downloadDir
        s.connections = (d["connections"] as? NSNumber)?.intValue ?? 8
        s.maxActive = (d["maxActive"] as? NSNumber)?.intValue ?? 3
        s.speedLimitKB = ((d["speedLimit"] as? NSNumber)?.intValue ?? 0) / 1024
        s.categorize = d["categorize"] as? Bool ?? true
        settings = s
    }

    var activeCount: Int { jobs.filter { $0.status == "downloading" }.count }
    var totalSpeed: Double { jobs.reduce(0) { $0 + ($1.status == "downloading" ? $1.speed : 0) } }

    private func updateDockBadge() {
        let n = activeCount
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
    }
}

// MARK: - Formatting

func fmtBytes(_ v: Double) -> String {
    if v <= 0 { return "–" }
    return ByteCountFormatter.string(fromByteCount: Int64(v), countStyle: .file)
}

func fmtTime(_ s: Double?) -> String {
    guard let s, s.isFinite, s >= 0 else { return "–" }
    let t = Int(s)
    if t < 60 { return "\(t)s" }
    if t < 3600 { return "\(t / 60)m \(t % 60)s" }
    return "\(t / 3600)h \((t % 3600) / 60)m"
}

// MARK: - Views

enum Filter: String, CaseIterable, Identifiable {
    case all = "All downloads", active = "Downloading", queued = "Queued", paused = "Paused", done = "Finished", failed = "Failed"
    case video = "Video", music = "Music", compressed = "Compressed", documents = "Documents", programs = "Programs"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .all: return "tray.full"
        case .active: return "arrow.down.circle"
        case .queued: return "clock"
        case .paused: return "pause.circle"
        case .done: return "checkmark.circle"
        case .failed: return "exclamationmark.triangle"
        case .video: return "film"
        case .music: return "music.note"
        case .compressed: return "doc.zipper"
        case .documents: return "doc.text"
        case .programs: return "app.badge"
        }
    }
    func matches(_ j: Job) -> Bool {
        switch self {
        case .all: return true
        case .active: return j.status == "downloading"
        case .queued: return j.status == "queued"
        case .paused: return j.status == "paused"
        case .done: return j.status == "done"
        case .failed: return j.status == "error"
        case .video: return j.category == "Video"
        case .music: return j.category == "Music"
        case .compressed: return j.category == "Compressed"
        case .documents: return j.category == "Documents"
        case .programs: return j.category == "Programs"
        }
    }
}

struct SegmentBar: View {
    let job: Job
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3).fill(Color.secondary.opacity(0.18))
                if job.status == "downloading" && !job.parts.isEmpty && job.size > 0 {
                    // one bar per connection, like IDM's segment map
                    ForEach(Array(job.parts.enumerated()), id: \.offset) { _, p in
                        Rectangle().fill(Color.accentColor)
                            .frame(width: max(0, g.size.width * p[2] / job.size))
                            .offset(x: g.size.width * p[0] / job.size)
                    }
                } else {
                    RoundedRectangle(cornerRadius: 3).fill(color).frame(width: g.size.width * job.progress)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 3))
        }
        .frame(height: 7)
    }
    var color: Color {
        switch job.status {
        case "done": return .green
        case "error": return .red
        case "paused": return .orange
        default: return .accentColor
        }
    }
}

struct StatusText: View {
    let job: Job
    var body: some View {
        switch job.status {
        case "downloading":
            if job.stage == "merging" { Text("Merging audio + video…") }
            else {
                Text(String(format: "%.1f%%", job.progress * 100) + (job.connections > 0 ? " · \(job.connections) connections" : ""))
            }
        case "queued": Text("Queued")
        case "paused": Text(String(format: "Paused at %.1f%%", job.progress * 100))
        case "done": Text("Finished")
        case "error": Text(job.error).foregroundStyle(.red).lineLimit(2)
        default: Text(job.status)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var engine: EngineClient
    @State private var filter: Filter? = .all
    @State private var selection = Set<String>()
    @State private var search = ""
    @State private var showAdd = false
    @State private var sortOrder = [KeyPathComparator(\Job.created, order: .reverse)]

    var visible: [Job] {
        let f = filter ?? .all
        let q = search.lowercased()
        return engine.jobs.filter { f.matches($0) && (q.isEmpty || ($0.name + " " + $0.url).lowercased().contains(q)) }
            .sorted(using: sortOrder)
    }
    var selectedJobs: [Job] { engine.jobs.filter { selection.contains($0.id) } }

    var body: some View {
        NavigationSplitView {
            List(selection: $filter) {
                Section("Status") {
                    ForEach([Filter.all, .active, .queued, .paused, .done, .failed]) { f in
                        Label(f.rawValue, systemImage: f.icon).badge(engine.jobs.filter(f.matches).count).tag(f)
                    }
                }
                Section("Categories") {
                    ForEach([Filter.video, .music, .compressed, .documents, .programs]) { f in
                        Label(f.rawValue, systemImage: f.icon).tag(f)
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190)
        } detail: {
            VStack(spacing: 0) {
                if !engine.connected {
                    banner(engine.lastError.isEmpty ? "Starting the VeloDM engine…" : engine.lastError, color: .orange)
                } else if !engine.hasYtdlp {
                    banner("Video sites need yt-dlp and ffmpeg: brew install yt-dlp ffmpeg", color: .yellow)
                }
                table
                footer
            }
        }
        .searchable(text: $search, prompt: "Filter downloads")
        .toolbar { toolbar }
        .sheet(isPresented: $showAdd) { AddURLView().environmentObject(engine) }
        .onDrop(of: [.url, .plainText], isTargeted: nil) { providers in
            for p in providers {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url, url.scheme?.hasPrefix("http") == true {
                        DispatchQueue.main.async { engine.add(url: url.absoluteString, filename: nil, engine: "auto") }
                    }
                }
            }
            return true
        }
        .onReceive(NotificationCenter.default.publisher(for: .showAdd)) { _ in showAdd = true }
    }

    func banner(_ text: String, color: Color) -> some View {
        Text(text).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 8).background(color.opacity(0.18))
    }

    var table: some View {
        Table(visible, selection: $selection, sortOrder: $sortOrder) {
            TableColumn("Name", value: \.name) { j in
                HStack(spacing: 8) {
                    Image(nsImage: icon(for: j)).resizable().frame(width: 20, height: 20)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(j.name).lineLimit(1)
                        Text(j.page.isEmpty ? j.url : j.page).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            .width(min: 220, ideal: 360)
            TableColumn("Size", value: \.size) { j in
                Text(j.status == "done" || j.size == 0 ? fmtBytes(max(j.size, j.done)) : "\(fmtBytes(j.done)) / \(fmtBytes(j.size))")
                    .monospacedDigit()
            }
            .width(min: 80, ideal: 130)
            TableColumn("Progress", value: \.done) { j in
                VStack(alignment: .leading, spacing: 3) {
                    SegmentBar(job: j)
                    StatusText(job: j).font(.caption).foregroundStyle(.secondary)
                }
            }
            .width(min: 140, ideal: 220)
            TableColumn("Speed", value: \.speed) { j in
                Text(j.status == "downloading" ? fmtBytes(j.speed) + "/s" : "").monospacedDigit()
            }
            .width(min: 70, ideal: 90)
            TableColumn("Time left") { j in
                Text(j.status == "downloading" ? fmtTime(j.eta) : "").monospacedDigit()
            }
            .width(min: 60, ideal: 80)
            TableColumn("Added", value: \.created) { j in
                Text(Date(timeIntervalSince1970: j.created), format: .dateTime.month(.abbreviated).day().hour().minute())
                    .foregroundStyle(.secondary)
            }
            .width(min: 90, ideal: 120)
        }
        .contextMenu(forSelectionType: String.self) { ids in
            let js = engine.jobs.filter { ids.contains($0.id) }
            rowMenu(js)
        } primaryAction: { ids in
            for j in engine.jobs where ids.contains(j.id) {
                if j.status == "done" { engine.act("open", j) }
                else if j.status == "paused" || j.status == "error" { engine.act("resume", j) }
            }
        }
    }

    @ViewBuilder func rowMenu(_ js: [Job]) -> some View {
        if js.contains(where: { $0.status == "done" }) {
            Button("Open") { js.filter { $0.status == "done" }.forEach { engine.act("open", $0) } }
            Button("Show in Finder") { js.forEach { engine.act("reveal", $0) } }
            Divider()
        }
        if js.contains(where: \.isActive) {
            Button("Pause") { js.filter(\.isActive).forEach { engine.act("pause", $0) } }
        }
        if js.contains(where: { $0.status == "paused" || $0.status == "error" }) {
            Button("Resume") { js.filter { $0.status == "paused" || $0.status == "error" }.forEach { engine.act("resume", $0) } }
        }
        Button("Download Again") { js.forEach { engine.act("redownload", $0) } }
        Button("Copy Address") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(js.map(\.url).joined(separator: "\n"), forType: .string)
        }
        Divider()
        Button("Remove from List") { js.forEach { engine.act($0.status == "done" ? "remove" : "cancel", $0) } }
        Button("Delete File", role: .destructive) { js.forEach { engine.act("remove", $0, extra: ["deleteFile": true]) } }
    }

    var footer: some View {
        HStack {
            Text("\(engine.jobs.count) downloads · \(engine.activeCount) active")
            Spacer()
            if engine.activeCount > 0 { Text("↓ " + fmtBytes(engine.totalSpeed) + "/s").monospacedDigit() }
            Circle().fill(engine.connected ? Color.green : Color.orange).frame(width: 7, height: 7)
            Text(engine.connected ? "Engine running" : "Engine offline")
        }
        .font(.caption).foregroundStyle(.secondary)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(.bar)
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button { showAdd = true } label: { Label("Add URL", systemImage: "plus") }
                .help("Add a download (⌘N)")
            Button { selectedJobs.isEmpty ? engine.all("resumeAll") : selectedJobs.forEach { engine.act("resume", $0) } } label: {
                Label("Resume", systemImage: "play.fill")
            }.help("Resume selected, or all")
            Button { selectedJobs.isEmpty ? engine.all("pauseAll") : selectedJobs.forEach { engine.act("pause", $0) } } label: {
                Label("Pause", systemImage: "pause.fill")
            }.help("Pause selected, or all")
            Button { selectedJobs.forEach { engine.act($0.status == "done" ? "remove" : "cancel", $0) } } label: {
                Label("Remove", systemImage: "xmark")
            }.disabled(selection.isEmpty).help("Remove selected")
            Button { engine.all("clearDone") } label: { Label("Clear Finished", systemImage: "checkmark.circle.badge.xmark") }
                .help("Clear finished downloads from the list")
            Button { engine.request(["cmd": "open"]) } label: { Label("Downloads Folder", systemImage: "folder") }
                .help("Open the downloads folder")
        }
    }

    func icon(for j: Job) -> NSImage {
        let ext = (j.name as NSString).pathExtension
        let type = UTType(filenameExtension: ext.isEmpty ? (j.kind == "ytdlp" ? "mp4" : "bin") : ext) ?? .data
        return NSWorkspace.shared.icon(for: type)
    }
}

struct AddURLView: View {
    @EnvironmentObject var engine: EngineClient
    @Environment(\.dismiss) var dismiss
    @State private var url = ""
    @State private var filename = ""
    @State private var mode = "auto"
    @State private var probing = false
    @State private var probeError = ""
    @State private var info: [String: Any]? = nil

    struct Choice: Hashable { let label: String; let detail: String; let format: String; let audio: Bool }

    var choices: [Choice] {
        guard let fm = info?["formats"] as? [[String: Any]] else { return [] }
        var best: [Int: [String: Any]] = [:]
        for f in fm {
            guard let h = (f["height"] as? NSNumber)?.intValue, (f["vcodec"] as? String ?? "none") != "none" else { continue }
            if best[h] == nil || (f["ext"] as? String) == "mp4" { best[h] = f }
        }
        var out = best.keys.sorted(by: >).map { h -> Choice in
            let sz = (best[h]?["size"] as? NSNumber)?.doubleValue ?? 0
            return Choice(label: "\(h)p", detail: sz > 0 ? fmtBytes(sz) : "", format: "bv*[height=\(h)]+ba/b[height=\(h)]/b", audio: false)
        }
        if fm.contains(where: { ($0["vcodec"] as? String) == "none" }) {
            out.append(Choice(label: "Audio only (MP3)", detail: "", format: "ba/b", audio: true))
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add Download").font(.headline)
            TextField("https://…", text: $url).textFieldStyle(.roundedBorder).frame(minWidth: 440)
            TextField("Save as (optional)", text: $filename).textFieldStyle(.roundedBorder)
            Picker("Engine", selection: $mode) {
                Text("Auto").tag("auto")
                Text("Direct file (multi-connection)").tag("direct")
                Text("Video site (YouTube, Vimeo, HLS…)").tag("ytdlp")
            }
            HStack {
                Button(probing ? "Checking…" : "Find Video Qualities") { runProbe() }
                    .disabled(url.isEmpty || probing)
                if !probeError.isEmpty { Text(probeError).font(.caption).foregroundStyle(.red).lineLimit(2) }
            }
            if let title = info?["title"] as? String {
                Text(title).font(.subheadline).bold().lineLimit(2)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 120))], alignment: .leading) {
                    ForEach(choices, id: \.self) { c in
                        Button {
                            engine.add(url: url, filename: filename, engine: "ytdlp", format: c.format, audioOnly: c.audio)
                            dismiss()
                        } label: {
                            VStack { Text(c.label); if !c.detail.isEmpty { Text(c.detail).font(.caption2).foregroundStyle(.secondary) } }
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Download") {
                    engine.add(url: url.trimmingCharacters(in: .whitespaces), filename: filename, engine: mode)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction).disabled(!url.hasPrefix("http"))
            }
        }
        .padding(20)
        .onAppear {
            if let s = NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines),
               s.hasPrefix("http"), !s.contains(" ") { url = s }
        }
    }

    func runProbe() {
        probing = true; probeError = ""; info = nil
        engine.probe(url) { r in
            probing = false
            if let e = r["error"] as? String { probeError = e } else { info = r }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var engine: EngineClient
    @State private var s = EngineSettings()
    var body: some View {
        Form {
            HStack {
                TextField("Download folder", text: $s.downloadDir)
                Button("Choose…") {
                    let p = NSOpenPanel(); p.canChooseDirectories = true; p.canChooseFiles = false
                    if p.runModal() == .OK, let u = p.url { s.downloadDir = u.path }
                }
            }
            Stepper("Connections per file: \(s.connections)", value: $s.connections, in: 1...32)
            Stepper("Downloads at once: \(s.maxActive)", value: $s.maxActive, in: 1...10)
            TextField("Speed limit per download (KB/s, 0 = off)", value: $s.speedLimitKB, format: .number)
            Toggle("Sort into Video, Music, Compressed, Documents, Programs folders", isOn: $s.categorize)
            HStack { Spacer(); Button("Save") { engine.saveSettings(s) }.keyboardShortcut(.defaultAction) }
        }
        .padding(20).frame(width: 520)
        .onAppear { s = engine.settings }
        .onChange(of: engine.settings) { _, v in s = v }
    }
}

struct MenuBarView: View {
    @EnvironmentObject var engine: EngineClient
    @Environment(\.openWindow) var openWindow
    var body: some View {
        let active = engine.jobs.filter { $0.status == "downloading" }
        if active.isEmpty { Text("No active downloads") }
        ForEach(active.prefix(8)) { j in
            Text("\(j.name.prefix(40)) — \(Int(j.progress * 100))% · \(fmtBytes(j.speed))/s")
        }
        Divider()
        Button("Show VeloDM") { NSApp.activate(ignoringOtherApps: true); openWindow(id: "main") }
        Button("Add URL…") {
            NSApp.activate(ignoringOtherApps: true); openWindow(id: "main")
            NotificationCenter.default.post(name: .showAdd, object: nil)
        }
        Button("Pause All") { engine.all("pauseAll") }
        Button("Resume All") { engine.all("resumeAll") }
        Divider()
        Button("Quit VeloDM (downloads keep running)") { NSApp.terminate(nil) }
        Button("Quit VeloDM and Stop Engine") { engine.all("quit"); DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) } }
    }
}

extension Notification.Name { static let showAdd = Notification.Name("velodm.showAdd") }

@main
struct VeloDMApp: App {
    @StateObject private var engine = EngineClient()

    var body: some Scene {
        Window("VeloDM", id: "main") {
            ContentView().environmentObject(engine).frame(minWidth: 820, minHeight: 420)
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Add URL…") { NotificationCenter.default.post(name: .showAdd, object: nil) }
                    .keyboardShortcut("n")
            }
        }
        Settings { SettingsView().environmentObject(engine) }
        MenuBarExtra {
            MenuBarView().environmentObject(engine)
        } label: {
            let n = engine.activeCount
            Image(systemName: n > 0 ? "arrow.down.circle.fill" : "arrow.down.circle")
            if n > 0 { Text(fmtBytes(engine.totalSpeed) + "/s") }
        }
    }
}
