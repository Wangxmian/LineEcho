import AppKit
import AVFoundation
import UniformTypeIdentifiers
import WebKit

@MainActor
final class ReaderApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private let port = 47860
    private let token = UUID().uuidString
    private var window: NSWindow!
    private var web: WKWebView!
    private var child: Process?
    private var startup: Task<Void, Never>?
    private var quitting = false
    private lazy var home = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appending(path: "Kokoro Reader", directoryHint: .isDirectory)
    private var origin: URL { URL(string: "http://127.0.0.1:\(port)")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Kokoro Reader"
        window.minSize = NSSize(width: 420, height: 460)
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        showStatus("正在启动 Kokoro Reader", detail: "正在载入本机阅读服务。")
        do {
            try launchReader()
            startup = Task { await openWhenReady() }
        } catch {
            showStatus("无法启动 Kokoro Reader", detail: error.localizedDescription)
        }
    }

    private func installMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = NSMenu()
        appItem.submenu?.addItem(withTitle: "退出 Kokoro Reader", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(appItem)

        let editItem = NSMenuItem()
        editItem.submenu = NSMenu(title: "编辑")
        for (title, action, key) in [
            ("剪切", "cut:", "x"), ("复制", "copy:", "c"),
            ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a"),
        ] {
            editItem.submenu?.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }

    private func launchReader() throws {
        guard let root = Bundle.main.resourceURL else {
            throw CocoaError(.fileNoSuchFile)
        }
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let log = home.appending(path: "server.log")
        try Data().write(to: log, options: .atomic)
        let output = try FileHandle(forWritingTo: log)
        defer { try? output.close() }

        let server = Process()
        server.executableURL = root.appending(path: "python/bin/python3")
        server.arguments = ["-I", "-B", root.appending(path: "macos/serve.py").path]
        server.currentDirectoryURL = home
        var environment = ProcessInfo.processInfo.environment
        for key in ["DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_INSERT_LIBRARIES", "PYTHONHOME", "PYTHONPATH"] {
            environment.removeValue(forKey: key)
        }
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        environment["KOKORO_DATA_DIR"] = home.appending(path: "data").path
        environment["KOKORO_DESKTOP_PORT"] = String(port)
        environment["KOKORO_CONTROL_TOKEN"] = token
        environment["KOKORO_NODE_BINARY"] = root.appending(path: "node/bin/node").path
        server.environment = environment
        server.standardOutput = output
        server.standardError = output
        try server.run()
        child = server
    }

    private func openWhenReady() async {
        let session = URLSession(configuration: .ephemeral)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: origin.appending(path: "_control/status"), timeoutInterval: 1)
        request.setValue(token, forHTTPHeaderField: "X-Kokoro-Control")
        for _ in 0..<160 {
            guard !Task.isCancelled else { return }
            guard let child, child.isRunning else {
                showStatus("本地服务启动失败", detail: "请检查端口 \(port) 是否被占用，或查看应用数据目录中的 server.log。")
                return
            }
            if let (_, response) = try? await session.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 200 {
                web.load(URLRequest(url: origin))
                return
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
        showStatus("等待本地服务超时", detail: "可以退出后重新打开。诊断日志位于应用数据目录。")
    }

    private func showStatus(_ title: String, detail: String) {
        func escaped(_ text: String) -> String {
            text.replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        }
        web.loadHTMLString("""
            <!doctype html><html lang="zh-CN"><meta charset="utf-8">
            <style>body{margin:0;background:#f4f5f8;color:#242037;font:15px -apple-system;
            display:grid;min-height:100vh;place-items:center}main{max-width:460px;padding:32px}h1{color:#4834d4}</style>
            <main><h1>\(escaped(title))</h1><p>\(escaped(detail))</p></main></html>
            """, baseURL: nil)
    }

    private func isLocal(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == origin.host && url.port == port
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let localFile = isLocal(url) || url.absoluteString.hasPrefix("blob:" + origin.absoluteString + "/")
        if action.shouldPerformDownload && localFile {
            decisionHandler(.download)
        } else {
            decisionHandler(isLocal(url) || url.absoluteString == "about:blank" ? .allow : .cancel)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.title = "保存音频"
        panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { reply in
            completionHandler(reply == .OK ? panel.url : nil)
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "导入文档"
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = ["docx", "md", "markdown", "txt"].compactMap { UTType(filenameExtension: $0) }
        panel.beginSheetModal(for: window) { reply in
            completionHandler(reply == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor securityOrigin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard type == .microphone, securityOrigin.protocol == "http",
              securityOrigin.host == origin.host, securityOrigin.port == port else {
            decisionHandler(.deny)
            return
        }
        Task { decisionHandler(await AVCaptureDevice.requestAccess(for: .audio) ? .grant : .deny) }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { reply in
            completionHandler(reply == .alertFirstButtonReturn)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        startup?.cancel()
        guard let child, child.isRunning else { return .terminateNow }
        if quitting { return .terminateLater }
        quitting = true
        child.terminationHandler = { _ in
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        if child.isRunning { child.terminate() }
        else { return .terminateNow }
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        }
        return .terminateLater
    }
}

@main
struct DesktopMain {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = ReaderApp()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
        withExtendedLifetime(delegate) {}
    }
}
