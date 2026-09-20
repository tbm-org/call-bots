// Native macOS shell for Call Bots: starts the bundled Node
// server and presents the UI in its own WKWebView window. Compiled by
// scripts/build-macos-app.mjs with `swiftc -swift-version 5`.
import Cocoa
import Sparkle
import WebKit

let port = ProcessInfo.processInfo.environment["CALL_BOTS_PORT"] ?? "4610"
let baseURL = URL(string: "http://127.0.0.1:\(port)")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, SPUUpdaterDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  var server: Process?
  var quitting = false
  private lazy var updaterController = SPUStandardUpdaterController(
    startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)

  // MARK: lifecycle

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    buildWindow()
    // GitHub's public asset API redirects to the signed archive with this header.
    updaterController.updater.httpHeaders = ["Accept": "application/octet-stream"]
    updaterController.startUpdater()
    // Check once on every launch. The scheduled daily check still covers the
    // uncommon case where someone leaves Call Bots open for several days.
    updaterController.updater.checkForUpdatesInBackground()
    probe { running in
      DispatchQueue.main.async {
        if running {
          // a server is already up (npm start or a second app launch): attach
          // to it without owning its lifetime
          self.load()
        } else {
          self.startServer()
          self.pollUntilReady(deadline: Date().addingTimeInterval(25))
        }
      }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
  func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

  func applicationWillTerminate(_ note: Notification) {
    quitting = true
    // SIGTERM triggers the server's own graceful teardown (leave calls, close
    // sim browsers); node finishes that even after this process is gone.
    if let server, server.isRunning { server.terminate() }
  }

  func feedURLString(for updater: SPUUpdater) -> String? {
    guard let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
          var url = URLComponents(string: feed) else { return nil }
    // A manual check should see a just-published release, not the CDN's old feed.
    url.queryItems = [URLQueryItem(name: "check", value: String(Int(Date().timeIntervalSince1970)))]
    return url.string
  }

  // MARK: window

  private func buildWindow() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Call Bots"
    window.minSize = NSSize(width: 980, height: 620)
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = NSColor(red: 0.043, green: 0.051, blue: 0.071, alpha: 1)
    window.center()
    window.setFrameAutosaveName("CallBotsMain")

    let webConfig = WKWebViewConfiguration()
    webView = WKWebView(frame: window.contentView!.bounds, configuration: webConfig)
    webView.autoresizingMask = [.width, .height]
    webView.navigationDelegate = self
    webView.uiDelegate = self
    if #available(macOS 12.0, *) { webView.underPageBackgroundColor = window.backgroundColor! }
    window.contentView!.addSubview(webView)

    showStatus("Starting server…")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let appMenu = NSMenu()
    let updateItem = NSMenuItem(
      title: "Check for Updates…",
      action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)),
      keyEquivalent: "")
    updateItem.target = updaterController
    appMenu.addItem(updateItem)
    appMenu.addItem(.separator())
    appMenu.addItem(
      NSMenuItem(title: "Quit Call Bots",
                 action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    appItem.submenu = appMenu

    let editItem = NSMenuItem()
    main.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    NSApp.mainMenu = main
  }

  private func showStatus(_ text: String) {
    let html = """
      <body style="margin:0;display:grid;place-items:center;height:100vh;background:#0b0d12;
                   color:#8b93a7;font:15px -apple-system,sans-serif">
        <div style="text-align:center">
          <div style="width:26px;height:26px;margin:0 auto 14px;border-radius:50%;
                      border:3px solid rgba(255,255,255,.12);border-top-color:#4f8cff;
                      animation:s .8s linear infinite"></div>\(text)
        </div><style>@keyframes s{to{transform:rotate(360deg)}}</style>
      </body>
      """
    webView.loadHTMLString(html, baseURL: nil)
  }

  // MARK: server process

  private func startServer() {
    guard let resources = Bundle.main.resourceURL else { return }
    let node = resources.appendingPathComponent("node/bin/node")
    let cli = resources.appendingPathComponent("app/src/cli.mjs")
    let home = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/CallBots")
    try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)

    let logURL = home.appendingPathComponent("server.log")
    if !FileManager.default.fileExists(atPath: logURL.path) {
      FileManager.default.createFile(atPath: logURL.path, contents: nil)
    }
    let logHandle = try? FileHandle(forWritingTo: logURL)
    logHandle?.seekToEndOfFile()

    let process = Process()
    process.executableURL = node
    process.arguments = [cli.path, "ui", "--port", port, "--no-open"]
    var env = ProcessInfo.processInfo.environment
    env["CALL_BOTS_HOME"] = home.path
    // The server watches this pid and stops when it is gone. applicationWill-
    // Terminate only runs for an ordinary quit, so a crash or a kill would
    // otherwise leave the server running with its bots in the call, holding
    // the port — and the next launch of the app, updated or not, would talk to
    // that old server instead of its own.
    env["CALL_BOTS_SUPERVISOR"] = String(ProcessInfo.processInfo.processIdentifier)
    process.environment = env
    if let logHandle {
      process.standardOutput = logHandle
      process.standardError = logHandle
    }
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, !self.quitting else { return }
        // server exited on its own (e.g. dashboard Quit button) — close the app
        self.quitting = true
        NSApp.terminate(nil)
      }
    }
    do {
      try process.run()
      server = process
    } catch {
      showStatus("Could not start the server: \(error.localizedDescription)")
    }
  }

  private func probe(_ completion: @escaping (Bool) -> Void) {
    var request = URLRequest(url: baseURL.appendingPathComponent("api/state"))
    request.timeoutInterval = 0.8
    URLSession.shared.dataTask(with: request) { _, response, _ in
      completion((response as? HTTPURLResponse)?.statusCode == 200)
    }.resume()
  }

  private func pollUntilReady(deadline: Date) {
    probe { running in
      DispatchQueue.main.async {
        if running {
          self.load()
        } else if Date() < deadline {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            self.pollUntilReady(deadline: deadline)
          }
        } else {
          self.showStatus(
            "Server did not start — see ~/Library/Application Support/CallBots/server.log")
        }
      }
    }
  }

  private func load() {
    webView.load(URLRequest(url: baseURL))
  }

  // MARK: navigation — keep the dashboard inside, everything else in the browser

  func webView(_ webView: WKWebView,
               decidePolicyFor navigationAction: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if let url = navigationAction.request.url, let host = url.host,
       host != "127.0.0.1", host != "localhost" {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView,
               createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction,
               windowFeatures: WKWindowFeatures) -> WKWebView? {
    // target=_blank (e.g. "Open call") goes to the user's real browser
    if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(_ webView: WKWebView,
               runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo,
               completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = "Call Bots"
    alert.informativeText = message
    alert.addButton(withTitle: "Remove")
    alert.addButton(withTitle: "Cancel")
    completionHandler(alert.runModal() == .alertFirstButtonReturn)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
