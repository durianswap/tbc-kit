import UIKit
import WebKit
import JavaScriptCore
import Security
import CryptoKit
import TbcEngine
import TbcSigner

enum LoopError: Error { case invalid, denied, stale, vault }
func object(_ value: Any?) throws -> [String: Any] { guard let o = value as? [String: Any] else { throw LoopError.invalid }; return o }
func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self) }
// Local comparison commitment, not a protocol hash or a redacted signing request.
func permitCommitment(_ value: Any) throws -> String {
    SHA256.hash(data: Data(try json(value).utf8)).map { String(format: "%02x", $0) }.joined()
}
func parse(_ value: String) throws -> Any { try JSONSerialization.jsonObject(with: Data(value.utf8), options: .fragmentsAllowed) }
func parseInstant(_ s: String) -> Date? { let f=ISO8601DateFormatter(); f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]; return f.date(from:s) ?? ISO8601DateFormatter().date(from:s) }
func instant() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}
func hex(_ value: String) throws -> [UInt8] {
    guard value.count == 64 else { throw LoopError.invalid }
    var out = [UInt8](); var i = value.startIndex
    while i < value.endIndex { let j = value.index(i, offsetBy: 2); guard let b = UInt8(value[i..<j], radix: 16) else { throw LoopError.invalid }; out.append(b); i = j }
    return out
}

// Isolated demo vault. PUBLIC scalar-1 is deliberately used with synthetic
// funding. Real custody/biometric policy is NOT claimed by this example.
@MainActor final class DemoVault {
    private let query: [String: Any]
    private let publicScalar: UInt8
    init(publicScalar: UInt8 = 1) throws {
        guard publicScalar == 1 || publicScalar == 2 else { throw LoopError.vault }
        self.publicScalar = publicScalar
        query = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "org.tbc.nativekit.closedloop.fixture",
            kSecAttrAccount as String: publicScalar == 1 ? "public-scalar-one" : "public-scalar-two"]
        var item = query
        item[kSecValueData as String] = Data(Array(repeating: UInt8(0), count: 31) + [publicScalar])
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let result = SecItemAdd(item as CFDictionary, nil)
        guard result == errSecSuccess || result == errSecDuplicateItem else { throw LoopError.vault }
    }
    func sign(digest: String, encoding: String) throws -> String {
        var lookup = query; lookup[kSecReturnData as String] = true
        var found: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &found) == errSecSuccess,
              let data = found as? Data, data.count == 32 else { throw LoopError.vault }
        var secret = [UInt8](data); defer { for i in secret.indices { secret[i] = 0 } }
        // Never accidentally use a different key left under this demo identity.
        guard secret.dropLast().allSatisfy({ $0 == 0 }), secret.last == publicScalar else { throw LoopError.vault }
        let digestBytes = try hex(digest)
        let format: TbcSignatureEncoding
        switch encoding {
        case "compact64": format = .compact64
        case "compact65-recoverable": format = .compact65Recoverable
        case "schnorr64": format = .schnorr64
        default: throw LoopError.invalid
        }
        let signature = try secret.withUnsafeBytes {
            try TbcDigestSigner.sign(digest: digestBytes, scalar: $0,
                encoding: format)
        }
        return signature.map { String(format: "%02x", $0) }.joined()
    }
#if TBC_SIGNER_MUSIG
    private func withMuSigScalar<T>(_ work: (UnsafeRawBufferPointer) throws -> T) throws -> T {
        var lookup = query; lookup[kSecReturnData as String] = true
        var found: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &found) == errSecSuccess,
              let data = found as? Data, data.count == 32 else { throw LoopError.vault }
        var secret = [UInt8](data)
        defer { _ = secret.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
        guard secret.dropLast().allSatisfy({ $0 == 0 }), secret.last == publicScalar else { throw LoopError.vault }
        return try secret.withUnsafeBytes(work)
    }
    func beginMuSig(authorization: TbcMuSigAuthorization,
                    authorize: @escaping @MainActor (TbcMuSigAuthorization) -> Bool) throws -> TbcMuSigSession {
        try withMuSigScalar { try TbcMuSigSession(publicKeys: ControlledMuSig.keys, aggregateKey: ControlledMuSig.aggregate,
            authorization: authorization, scalar: $0, authorize: authorize) }
    }
    func signMuSig(_ session: TbcMuSigSession, authorization: TbcMuSigAuthorization, nonces: [[UInt8]]) throws -> [UInt8] {
        try withMuSigScalar { try session.sign(authorization: authorization, scalar: $0, publicNonces: nonces) }
    }
#endif
}

@MainActor final class WalletController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    let fence = NativeSessionFence()
    let engine = try! TbcEngine()
    let keylessEngine = try! TbcKeylessEngine()
    var vault: DemoVault?
    var adminVault: DemoVault?
    var controlledCoinAdmin: Bool { config["controlledCoinAdmin"] as? Bool == true }
    var controlledCoinMuSig: Bool { config["controlledCoinMuSig"] as? Bool == true }
    var realCoinAdmin: Bool { config["realCoinAdmin"] as? Bool == true }
    var hasCoinAdmin: Bool { controlledCoinAdmin || realCoinAdmin }
    var controlledPoolController: Bool { config["controlledPoolController"] as? Bool == true }
    var controlledSecondarySigner: Bool { controlledCoinAdmin || controlledPoolController }
    var hasSecondarySigner: Bool { hasCoinAdmin || controlledPoolController }
    var secondarySigningRole: String { controlledPoolController ? "pool-controller" : "coin-admin" }
    var secondaryRoleLabel: String { controlledPoolController ? "Pool controller" : "Coin administrator" }
    var signingAccounts: [[String: Any]] {
        hasSecondarySigner ? config["accounts"] as! [[String: Any]] : [config["account"] as! [String: Any]]
    }
    var testnetVault: TestnetVault?
    var testnetAdminVault: TestnetVault?
    var broadcastDatabase: NativeSqliteStore?
    let http = TestnetHTTP()
    var realTestnet: Bool { config["realTestnet"] as? Bool == true }
    var selfTransferAtomic: String { config["selfTransferAtomic"] as? String ?? "1000" }
    var context: JSContext!
    var web: WKWebView!
    var config: [String: Any] = [:], authority: [String: Any] = [:]
    var document = UUID().uuidString, ready = false
    var timers: [Int: DispatchWorkItem] = [:]
    var permits: [String: Permit] = [:]
    var jobConsent: [String: Any]? = nil
    var metrics: [[String: Any]] = []
    func measure(_ phase: String, _ fields: [String: Any] = [:]) { var row=fields; row["phase"]=phase; row["monoMs"]=ProcessInfo.processInfo.systemUptime*1000; metrics.append(row) }
    var seen = Set<String>(), counts: [String: Int] = [:], results: [[String: Any]] = []
    var cancelApproval: (() -> Void)?
    // Demo permissions are native-owned memory, retained across VM recreation,
    // cleared on App restart. No pregrant in onboarding mode, no production DB claim.
    var permissionRows: [String: [String: Any]] = [:]
    var permissionCommits: [String: (String, String)] = [:]
    var permissionDatabase: NativeSqliteStore?
    var permissionPersistence: NativePermissionPersistence?
    var permissionRestored = false
    var setupDiagnostic = ""
    let processID = UUID().uuidString
    var onboarding: Bool { config["onboarding"] as? Bool == true }
    struct Permit {
        let ticket: NativeSessionFence.Ticket
        let receipt: [String: Any]
        var tasks: [[String: Any]]
        let bindingPayload: [String: Any]
        var stage = 0
        let messageDigest: String?
        var used = Set<String>()
        var workflowPlan: [String: Any]? = nil
        var workflowTasks: [[String: Any]] = []
        var workflowStages: [String: Int] = [:]
        var actionTaskCommitment: String? = nil
        var reviewedTaskCommitments = Set<String>()
        var reviewedMaterialCommitments: [String: String] = [:]
        // Signed parents remain only in the current approval's memory.
        var reviewedParents: [String: [String]] = [:]
        var reviewedCallIDs: [String: String] = [:]
    }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        config = try! object(parse(String(contentsOf: Bundle.main.url(forResource: "fixture", withExtension: "json")!, encoding: .utf8)))
        var startupStage = "vault"
        do {
            guard !controlledCoinMuSig || (controlledCoinAdmin && !realTestnet && !controlledPoolController) else { throw LoopError.invalid }
#if !TBC_SIGNER_MUSIG
            guard !controlledCoinMuSig else { throw LoopError.invalid }
#endif
            guard !realCoinAdmin || (realTestnet && !controlledCoinAdmin) else { throw LoopError.invalid }
            guard !controlledPoolController || (!realTestnet && !hasCoinAdmin) else { throw LoopError.invalid }
            if controlledSecondarySigner {
                let adminAddress = controlledCoinMuSig ? "1CwpmPr76joFAXxut3k1kgkqdJL9DeJ2VR" : "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP"
                let adminPublicKey = controlledCoinMuSig ? "023b46d262d2f610e9038b44beabdfe97ab5a0feb89870acc2264edfb7f63ec2ec" : "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
                guard !realTestnet, let accounts = config["accounts"] as? [[String: Any]], accounts.count == 2,
                      try json(accounts[0]) == json(config["account"]!),
                      accounts[0]["accountId"] as? String == "tbc:testnet:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
                      accounts[0]["publicKey"] as? String == "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
                      accounts[1]["chainId"] as? String == "tbc:testnet",
                      accounts[1]["address"] as? String == adminAddress,
                      accounts[1]["accountId"] as? String == "tbc:testnet:" + adminAddress,
                      accounts[1]["publicKey"] as? String == adminPublicKey else { throw LoopError.invalid }
                adminVault = try DemoVault(publicScalar: 2)
            }
            try http.configure(apiOrigin: config["apiOrigin"] as? String ?? "https://api.tbcdev.org")
            if realTestnet {
                let custody = try TestnetVault(); testnetVault = custody
                let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                startupStage = "identity-proof"
                let proof = try custody.proof()
                var adminProof: [String: String]? = nil
                if realCoinAdmin {
                    let admin = try TestnetVault(slot: .coinAdmin); testnetAdminVault = admin
                    adminProof = try admin.proof()
                    try json(adminProof!).write(to: directory.appendingPathComponent("testnet-admin-identity-proof.json"), atomically: true, encoding: .utf8)
                }
                startupStage = "identity-proof-write"
                try json(proof).write(to: directory.appendingPathComponent("testnet-identity-proof.json"), atomically: true, encoding: .utf8)
                guard let accountText = try? String(contentsOf: directory.appendingPathComponent("real-account.json"), encoding: .utf8) else {
                    let label = UILabel(frame: view.bounds); label.text = "Testnet identity generated in Keychain. Awaiting verified PUBLIC account metadata; signing and broadcast disabled."; label.numberOfLines = 0; view.addSubview(label); return
                }
                let metadata = try object(parse(accountText))
                startupStage = "identity-binding"
                guard try json(metadata["proof"]!) == json(proof), let account = metadata["account"] as? [String: Any],
                      account["chainId"] as? String == "tbc:testnet", let address = account["address"] as? String,
                      account["accountId"] as? String == "tbc:testnet:" + address else { throw LoopError.invalid }
                config["account"] = account
                if realCoinAdmin {
                    guard let text = try? String(contentsOf: directory.appendingPathComponent("real-admin-account.json"), encoding: .utf8) else {
                        let label = UILabel(frame: view.bounds); label.text = "Independent Coin administrator generated in Keychain. Awaiting verified PUBLIC administrator metadata; signing and broadcast disabled."; label.numberOfLines = 0; view.addSubview(label); return
                    }
                    let adminMetadata = try object(parse(text))
                    guard let recordedProof = adminMetadata["proof"], try json(recordedProof) == json(adminProof!),
                          let admin = adminMetadata["account"] as? [String: Any], admin["chainId"] as? String == "tbc:testnet",
                          let adminAddress = admin["address"] as? String,
                          admin["accountId"] as? String == "tbc:testnet:" + adminAddress,
                          adminAddress != address, let adminKey = admin["publicKey"] as? String,
                          adminKey != account["publicKey"] as? String else { throw LoopError.invalid }
                    config["accounts"] = [account, admin]
                }
                startupStage = "broadcast-storage"
                let location = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                try FileManager.default.createDirectory(at: location, withIntermediateDirectories: true)
                broadcastDatabase = try NativeSqliteStore(url: location.appendingPathComponent("testnet-broadcast.sqlite"))
            } else { vault = try DemoVault() }
        } catch {
            if case TestnetVault.Failure.keychain(let status) = error { startupStage += ".osstatus-" + String(status) }
            let label = UILabel(frame: view.bounds); label.text = "Native setup failed at \(startupStage). Signing is disabled."; label.numberOfLines = 0; view.addSubview(label)
            counts["setupFailure." + startupStage, default: 0] += 1; save(); return
        }
        permissionRows["tbc:testnet"] = ["revision": "0", "permissions": config["permissions"]!]
        if config["persistentPermissions"] as? Bool == true {
            do {
                let location = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                try FileManager.default.createDirectory(at: location, withIntermediateDirectories: true)
                let database = try NativeSqliteStore(url: location.appendingPathComponent("native-permissions.sqlite"))
                permissionDatabase = database
                let account = try object(config["account"])
                let store = try NativePermissionPersistence(database: database, origin: config["origin"] as! String, accountID: account["accountId"] as! String)
                if let state = try store.load() {
                    guard let rows = state["rows"] as? [String: [String: Any]], let commits = state["commits"] as? [String: [String]], commits.count <= 1024 else { throw LoopError.invalid }
                    for (chain, row) in rows {
                        guard ["tbc:mainnet", "tbc:testnet"].contains(chain), let revision = row["revision"] as? String,
                              UInt64(revision) != nil, let grants = row["permissions"] as? [[String: Any]],
                              grants.allSatisfy({ $0["invoker"] as? String == config["origin"] as? String }) else { throw LoopError.invalid }
                    }
                    for values in commits.values { guard values.count == 2 else { throw LoopError.invalid } }
                    permissionRows = rows; permissionCommits = commits.mapValues { ($0[0], $0[1]) }; permissionRestored = true
                }
                permissionPersistence = store
            } catch {
                let label = UILabel(frame: view.bounds); label.text = "Permission storage unavailable. Wallet disabled."; label.numberOfLines = 0; view.addSubview(label); return
            }
        }
        let content = WKUserContentController(); content.add(self, name: "tbc")
        let setup = WKWebViewConfiguration(); setup.userContentController = content
        web = WKWebView(frame: .zero, configuration: setup); web.navigationDelegate = self
        let reset = UIButton(type: .system); reset.setTitle("Recreate trusted VM", for: .normal)
        reset.addTarget(self, action: #selector(recreate), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [reset, web]); stack.axis = .vertical; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack); NSLayoutConstraint.activate([stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor), stack.leadingAnchor.constraint(equalTo: view.leadingAnchor), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor), reset.heightAnchor.constraint(equalToConstant: 45)])
        buildVM(); web.load(URLRequest(url: URL(string: config["origin"] as! String)!))
    }
    func invalidate() {
        ready = false; fence.close(); permits.removeAll(); seen.removeAll(); document = UUID().uuidString
        http.invalidate(); broadcastDatabase?.invalidate()
        let cancel = cancelApproval; cancelApproval = nil; cancel?()
        context?.evaluateScript("__closeWallet()"); timers.values.forEach { $0.cancel() }; timers.removeAll()
        presentedViewController?.dismiss(animated: false)
    }
    @objc func recreate() { invalidate(); context = nil; buildVM(); web.reload(); counts["vmRecreated", default: 0] += 1; save() }
    func buildVM() {
        context = JSContext()!
        context.exceptionHandler = { _, _ in /* Errors are delivered through bounded request results, no secret logging. */ }
        let encode: @convention(block) (String) -> [NSNumber] = { Array($0.utf8).map { NSNumber(value: $0) } }
        let decode: @convention(block) ([NSNumber]) -> String? = { String(bytes: $0.map { $0.uint8Value }, encoding: .utf8) }
        let now: @convention(block) () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }
        let url: @convention(block) (String) -> String? = { input in
            // Restricted to verified HTTPS or loopback HTTP. Not a generic
            // browser URL polyfill; unsupported URL forms fail closed.
            guard let u = URLComponents(string: input), let host = u.host,
                  let scheme = u.scheme, u.user == nil, u.password == nil,
                  scheme == "https" || (scheme == "http" && ["127.0.0.1", "localhost"].contains(host)) else { return nil }
            let port = u.port.map(String.init) ?? ""
            let authority = host + (port.isEmpty || (scheme == "https" && port == "443") || (scheme == "http" && port == "80") ? "" : ":" + port)
            return try? json(["href": input, "origin": scheme + "://" + authority, "protocol": scheme + ":", "host": authority,
                "hostname": host, "port": port, "username": "", "password": "", "pathname": u.path.isEmpty ? "/" : u.path, "search": u.query.map { "?" + $0 } ?? "", "hash": u.fragment.map { "#" + $0 } ?? ""])
        }
        let networkURL: @convention(block) (String, String, String) -> String? = { TestnetHTTP.resolveURL($0, $1, $2) }
        let schedule: @convention(block) (Int, Double) -> Void = { [weak self] id, ms in
            guard let self else { return }; let target = self.context!
            let work = DispatchWorkItem { [weak self] in self?.timers.removeValue(forKey: id); target.objectForKeyedSubscript("__fireTimer")?.call(withArguments: [id]) }
            self.timers[id] = work; DispatchQueue.main.asyncAfter(deadline: .now() + max(0, ms) / 1000, execute: work)
        }
        let cancel: @convention(block) (Int) -> Void = { [weak self] id in self?.timers.removeValue(forKey: id)?.cancel() }
        let native: @convention(block) (String, String, String) -> Void = { [weak self] id, method, input in
            guard let self else { return }; let target = self.context!
            guard let ticket = try? self.fence.capture(timeoutSeconds: 120) else { target.objectForKeyedSubscript("__settle")?.call(withArguments: [id, "", "closed"]); return }
            Task { @MainActor in
                do {
                    try self.fence.check(ticket)
                    self.counts[method, default: 0] += 1
                    let value = try await self.dispatch(method, input)
                    try self.fence.finish(ticket)
                    target.objectForKeyedSubscript("__settle")?.call(withArguments: [id, value, ""])
                } catch { target.objectForKeyedSubscript("__settle")?.call(withArguments: [id, "", "rejected"]) }
            }
        }
        let completed: @convention(block) (String, String, String) -> Void = { [weak self] id, status, code in self?.complete(id, status, code) }
        let opened: @convention(block) (String) -> Void = { [weak self] navigation in
            guard let self, navigation == self.document else { return }; self.ready = true; self.web.evaluateJavaScript("ready()")
        }
        let failed: @convention(block) (String) -> Void = { [weak self] message in self?.setupDiagnostic = String(message.prefix(300)); self?.counts["openFailed", default: 0] += 1; self?.save() }
        for (name, value) in ["__encode": encode as Any, "__decode": decode as Any, "__now": now as Any, "__url": url as Any,
                              "__schedule": schedule as Any, "__cancelTimer": cancel as Any, "__nativeCall": native as Any,
                              "__completed": completed as Any, "__opened": opened as Any, "__openFailed": failed as Any, "__networkURL": networkURL as Any] {
            context.setObject(value, forKeyedSubscript: name as NSString)
        }
        for file in (realTestnet ? ["bootstrap", "network-bootstrap", "wallet"] : ["bootstrap", "wallet"]) { context.evaluateScript(try! String(contentsOf: Bundle.main.url(forResource: file, withExtension: "js")!, encoding: .utf8)) }
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { invalidate() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = webView.url, let u = URLComponents(url: url, resolvingAgainstBaseURL: false), let host = u.host else { return }
        let origin = "\(u.scheme ?? "")://\(host)" + (u.port.map { ":\($0)" } ?? "")
        guard origin == config["origin"] as? String else { return }
        let account = config["account"] as! [String: Any], session = UUID().uuidString
        authority = ["currentContext": ["sessionId": session, "transport": "webview", "origin": origin, "topOrigin": origin, "frame": "top", "navigationId": document, "createdAt": instant()],
            "currentSession": ["version": "1.0", "scope": ["walletProfile": "native-wallet-integration", "sessionId": session],
                "state": ["version": "1.0", "sessionId": session, "revision": "0", "connected": true, "activeChainId": "tbc:testnet", "activeAccountIds": signingAccounts.map { $0["accountId"] as! String }.sorted()]]]
        try! fence.replaceVerifiedScope(.init(origin: origin, navigationID: document, accountID: account["accountId"] as! String, chainID: "tbc:testnet"))
        context.evaluateScript("__openWallet(\(try! json(UUID().uuidString)),\(realTestnet ? "true" : "false"),\(try! json(config["apiOrigin"] as? String ?? "https://api.tbcdev.org"))).then(()=>__opened(\(try! json(document)))).catch(e=>__openFailed(String(e.name)+': '+String(e.message)))")
    }
    var deliveries: [String: NativeSessionFence.DeliveryTicket] = [:]
    var requestMethods: [String: String] = [:]
    func rejectLiveRequest(_ id: String, code: Int) {
        counts["transportRejected", default: 0] += 1
        results.append(["outcome":"transport-rejected", "code":String(code), "time":instant(), "counts":counts])
        web.evaluateJavaScript("receive(\(try! json(document + ":" + id)),{ok:false,code:\(code)})")
        save()
    }
    // BEGIN ACCEPTANCE_PROFILE_MATCH
    func matchesAcceptanceProfile(_ entry: [String: Any], _ intent: [String: Any], _ constraints: [String: Any], _ signingRoles: Any? = nil) -> Bool {
        if let expected = entry["signingRoles"] as? [[String: Any]] {
            guard let actual = signingRoles as? [[String: Any]], NSArray(array: actual).isEqual(to: expected) else { return false }
        } else if signingRoles != nil { return false }
        guard let expected = entry["intent"] as? [String: Any],
              constraints["maxFee"] as? String == entry["maxFee"] as? String,
              Set(constraints.keys).isSubset(of: ["maxFee", "expiresAt", "inputOutpoints"]) else { return false }
        var comparable = intent
        if entry["runtimePreimage"] as? Bool == true {
            guard expected["type"] as? String == "tbc-htlc-claim", expected["preimage"] == nil,
                  let value = comparable["preimage"] as? String, value.utf8.count <= 130848,
                  value.utf8.count % 2 == 0,
                  value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return false }
            comparable.removeValue(forKey: "preimage")
        }
        guard NSDictionary(dictionary: comparable).isEqual(to: expected) else { return false }
        if let selected = (entry["constraints"] as? [String: Any])?["inputOutpoints"] as? [[String: Any]] {
            guard let actual = constraints["inputOutpoints"] as? [[String: Any]], NSArray(array: actual).isEqual(to: selected) else { return false }
        } else if constraints["inputOutpoints"] != nil { return false }
        return true
    }
    // END ACCEPTANCE_PROFILE_MATCH
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        var liveID: String?
        do {
            guard ready, message.frameInfo.isMainFrame else { throw LoopError.invalid }
            let security = message.frameInfo.securityOrigin
            let actual = "\(security.protocol)://\(security.host)" + (security.port == 0 ? "" : ":\(security.port)")
            guard actual == config["origin"] as? String else { throw LoopError.invalid }
            let body = try object(message.body), request = try object(body["request"])
            guard let id = body["id"] as? String, !id.isEmpty, id.count < 80, !seen.contains(id) else { throw LoopError.invalid }
            seen.insert(id); liveID = id
            guard try json(body).utf8.count <= 4 * 1024 * 1024, let method = request["method"] as? String else { throw LoopError.invalid }
            guard (config["pageMethods"] as? [String] ?? []).contains(method) else { rejectLiveRequest(id, code:4200); return }
            if ["tbc_sendTransaction", "tbc_sendPreparedTransaction"].contains(method) {
                // Independently enforce the trusted build-time acceptance profile.
                let params = try object(request["params"]), intent = try object(params["intent"]), constraints = try object(params["constraints"])
                let address = try object(config["account"])["address"] as? String
                guard params["chainId"] as? String == "tbc:testnet", params["from"] as? String == address else { throw LoopError.denied }
                if let ft = (config["transactionProfile"] as? [String: Any]) ?? (config["ftTransfer"] as? [String: Any]), ft["intent"] is [String: Any] {
                    guard matchesAcceptanceProfile(ft, intent, constraints, params["signingRoles"]) else { throw LoopError.denied }
                } else if let suite = (config["transactionProfile"] as? [String: Any])?["cases"] as? [[String: Any]] {
                    guard suite.contains(where: { entry in
                        matchesAcceptanceProfile(entry, intent, constraints, params["signingRoles"])
                    }) else { throw LoopError.denied }
                } else {
                    guard intent["type"] as? String == "tbc.transfer", intent["to"] as? String == address,
                          intent["amount"] as? String == selfTransferAtomic, constraints["maxFee"] as? String == "200" else { throw LoopError.denied }
                }
            }
            let delivery = document + ":" + id
            if ["tbc_sendWorkflow", "tbc_sendPreparedWorkflow"].contains(method) {
                let p = try object(request["params"]), address = try object(config["account"])["address"] as? String
                guard realTestnet, p["chainId"] as? String == "tbc:testnet", p["from"] as? String == address,
                      p["maxTotalFee"] as? String == "400", let steps = p["steps"] as? [[String: Any]], !steps.isEmpty, steps.count <= 4 else { throw LoopError.denied }
                for step in steps where ["transaction", "preparedTransaction"].contains(step["kind"] as? String ?? "") {
                    let intent = try object(step["intent"])
                    guard intent["type"] as? String == "tbc.transfer", intent["to"] as? String == address,
                          intent["amount"] as? String == "1000", (try object(step["constraints"])["maxFee"] as? String) == "200" else { throw LoopError.denied }
                }
                guard steps.allSatisfy({ ["transaction", "preparedTransaction", "message", "typedData"].contains($0["kind"] as? String ?? "") }) else { throw LoopError.denied }
            }
            requestMethods[delivery] = method
            deliveries[delivery] = try fence.captureDelivery(
                authorizationBound: (config["authorizationBoundMethods"] as? [String] ?? []).contains(method))
            counts["request", default: 0] += 1
            context.evaluateScript("__requestWallet(\(try json(try json(request)))).then(r=>__completed(\(try json(delivery)),'signed',JSON.stringify(r))).catch(e=>__completed(\(try json(delivery)),'rejected',String(e.code??'native'))) ")
        } catch {
            if let id = liveID { rejectLiveRequest(id, code:-32602) }
            else { counts["transportRejected", default: 0] += 1; save() }
        }
    }
    func complete(_ id: String, _ status: String, _ code: String) {
        guard let ticket = deliveries.removeValue(forKey: id) else { return }
        var outcome = status, resultCode = status == "signed" ? "" : code
        do {
            try fence.finishDelivery(ticket)
            let response: [String: Any] = status == "signed" ? ["ok": true, "result": try parse(code)] : ["ok": false, "code": code]
            web.evaluateJavaScript("receive(\(try json(id)),\(try json(response)))")
        }
        catch NativeSessionFence.Failure.revoked {
            // Scope validation preceded REVOKED: only the same live document
            // receives a fixed cancellation, never the stale signature/result.
            outcome = "revoked-cancelled"; resultCode = "4100"
            web.evaluateJavaScript("receive(\(try! json(id)),{ok:false,code:'4100'})")
        }
        catch { outcome = "stale-suppressed" }
        let itemCount = status == "signed" ? ((try? parse(code)) as? [Any])?.count : nil
        var entry: [String: Any] = ["outcome": outcome, "code": resultCode, "counts": counts, "time": instant(), "items": itemCount ?? -1]
        if let method = requestMethods.removeValue(forKey:id) {
            entry["method"] = method
            if status == "signed", ["tbc_chainId","tbc_accounts","tbc_requestAccounts","tbc_getAccount","tbc_getCapabilities","wallet_getPermissions","tbc_switchChain","tbc_disconnect"].contains(method) { entry["publicResult"] = try? parse(code) }
        }
        if realTestnet, status == "signed", let result = (try? parse(code)) as? [String: Any] {
            // Public IDs only; never store raw signed bytes or signatures in evidence.
            if let txid = result["txid"] as? String { entry["txid"] = txid }
            if let txids = result["txids"] as? [String] { entry["txids"] = txids }
            entry["resultKeys"] = Array(result.keys).sorted()
        }
        if status == "signed", let publicResult = try? parse(code) { entry["publicResult"] = publicResult }
        measure("wallet-return",["status":outcome]); results.append(entry); save()
    }
    func save() {
        let report: [String: Any] = ["marker": "NATIVE_KIT_CLOSED_LOOP", "counts": counts, "results": results,
            "metrics":metrics, "candidate":"0.1.0-rc.25", "nativeEngine": true, "nativeRustSigner": true, "keyStorage": realTestnet ? "isolated-Keychain-native-random-testnet-key" : "isolated-Keychain-public-test-key", "syntheticChain": !realTestnet, "externalPosts": counts["http.POST", default: 0], "productionCustody": false,
            "realTestnet": realTestnet, "account": config["account"] ?? [:],
            "setupDiagnostic": setupDiagnostic,
            "onboarding": onboarding, "permissionRows": permissionRows,
            "processID": processID, "permissionRestored": permissionRestored,
            "permissionStorage": permissionPersistence == nil ? "native-session-memory" : "native-sqlite-grants-only"]
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? (try json(report)).write(to: directory.appendingPathComponent("report.json"), atomically: true, encoding: .utf8)
    }
    func dispatch(_ method: String, _ input: String) async throws -> String {
        if method.hasPrefix("keyless."), let operation = TbcKeylessOperation(rawValue: String(method.dropFirst(8))) {
            return try await keylessEngine.callEnvelope(operation, canonicalInput: input)
        }
        if method.hasPrefix("engine."), let operation = TbcEngineMethod(rawValue: String(method.dropFirst(7))) {
            let raw = try await engine.callEnvelope(operation, canonicalInput: input)
            if method == "engine.validate" { try acceptValidatedContinuation(input, raw) }
            if let envelope = try? object(parse(raw)), envelope["ok"] as? Bool == false,
               let error = envelope["error"] as? [String: Any], let code = error["code"] as? String {
                counts["engineError." + code, default: 0] += 1; save()
            }
            if let envelope = try? object(parse(raw)), let result = envelope["result"] as? [String: Any],
               let violations = result["violations"] as? [[String: Any]] {
                for violation in violations { if let code = violation["code"] as? String { counts["violation." + code, default: 0] += 1 } }; save()
            }
            return raw
        }
        let data = try parse(input)
        if method.hasPrefix("sqlite."), realTestnet, let database = broadcastDatabase {
            return try json(database.call(method, (data as? [String: Any]) ?? [:]))
        }
        switch method {
        case "http.request":
            guard realTestnet else { throw LoopError.denied }
            let request = try object(data)
            let httpStart = ProcessInfo.processInfo.systemUptime
            var fields:[String:Any] = ["url":request["url"] ?? "", "method":request["method"] ?? ""]
            if (request["url"] as? String ?? "").contains("/txo/status"), let body=request["body"] as? String, let parsed=(try? parse(body)) as? [String:Any] { fields["txos"]=parsed["txos"] }
            measure("http-start", fields)
            defer { measure("http-end", ["url":request["url"] ?? "", "method":request["method"] ?? "", "elapsedMs":(ProcessInfo.processInfo.systemUptime-httpStart)*1000]) }
            return try await http.request(request) { verb in
                self.counts["http." + verb, default: 0] += 1
                if verb == "POST" { self.counts[(request["url"] as? String ?? "").contains("/txo/status") ? "readonly.POST" : "broadcast.POST", default: 0] += 1 }
                self.save()
            }
        case "http.cancel":
            guard realTestnet, let id = try object(data)["id"] as? String else { throw LoopError.denied }
            http.cancel(id); return "null"
        case "accounts.current": return try json(signingAccounts)
        case "accounts.forChain":
            let chain = try object(data)["chainId"] as? String
            guard chain == "tbc:testnet" else { throw LoopError.denied }
            return try json(signingAccounts.filter { $0["chainId"] as? String == chain })
        case "wallet.signingRoles": return try json(Array(Set((hasSecondarySigner ? [secondarySigningRole] : []) + (realTestnet ? ["coin-admin"] : []))).sorted())
        case "authority.read": return try json(authority)
        case "clock.now": return try json(instant())
        case "entropy.bytes":
            let n = try object(data)["length"] as? Int ?? 0; guard n > 0, n <= 1024 else { throw LoopError.invalid }
            var bytes = [UInt8](repeating: 0, count: n); guard SecRandomCopyBytes(kSecRandomDefault, n, &bytes) == errSecSuccess else { throw LoopError.invalid }; return try json(bytes)
        case "permissions.load":
            let scope = try object(object(object(data)["params"])["scope"])
            let chain = try permissionChain(scope)
            return try json(permissionRows[chain] ?? ["revision": "0", "permissions": []])
        case "permissions.commit": return try commitPermissions(object(data))
        case "authority.commit":
            let input = try object(data), mutation = try object(input["mutation"]), payload = try object(mutation["payload"])
            let current = try object(authority["currentSession"]), target = try object(payload["target"])
            guard try json(input["expected"]!) == json(authority),
                  try json(payload["scope"]!) == json(current["scope"]!),
                  payload["expectedRevision"] as? String == (try object(current["state"])["revision"] as? String) else { throw LoopError.stale }
            authority["currentSession"] = ["version": "1.0", "scope": payload["scope"]!, "state": target]
            return try json(["acknowledgment": ["version": "1.0", "commitId": input["commitId"]!, "status": "committed", "revision": target["revision"]!], "authority": authority])
        case "chain.read":
            guard !realTestnet else { throw LoopError.denied }
            let query = try object(data)
            if let steps = query["workflowSteps"] as? [[String: Any]] {
                // Isolated fixture only. Real Testnet uses Kit's shared loader.
                guard controlledSecondarySigner, steps.count == 1 else { throw LoopError.denied }
                let step = steps[0], snapshot = try object(config["snapshot"])
                guard let stepID = step["stepId"] as? String,
                      let selectedAccounts = step["signingAccounts"] as? [[String: Any]],
                      let selectedRoles = step["signingRoles"] as? [[String: Any]],
                      let expectedAccounts = try object(snapshot["payload"])["signingAccounts"] as? [[String: Any]],
                      try object(step["requirement"])["intentType"] as? String == (controlledPoolController ? "tbc-amm-swap" : "tbc20-stablecoin-create"),
                      try json(selectedAccounts) == json(expectedAccounts),
                      try json(selectedRoles) == json([["role":secondarySigningRole,"accountId":signingAccounts[1]["accountId"]!]]) else { throw LoopError.denied }
                return try json(["version":"1.0","steps":[["stepId":stepID,"snapshot":snapshot]]])
            }
            return try json(config["snapshot"]!)
        case "policy.read": guard !realTestnet else { throw LoopError.denied }; return try json(config["policy"]!)
        case "job.approve": return try await approveJob(try object(data))
        case "job.authorize": return try authorizeJob(try object(data))
        case "approval.request": return try await approve(try object(data))
        case "signer.sign": return try sign(try object(data))
        case "crypto.execute": return try crypt(try object(data))
        case "reviewed.execute": return try await reviewed(try object(data))
        case "reviewed.signStage": return try await reviewed(try object(data), stageOnly: true)
        default: throw LoopError.invalid // No broadcasts, method reflection or generic private ABI.
        }
    }
    func permissionChain(_ scope: [String: Any]) throws -> String {
        guard scope["origin"] as? String == config["origin"] as? String,
              let chain = scope["chainId"] as? String, ["tbc:mainnet", "tbc:testnet"].contains(chain) else { throw LoopError.denied }
        return chain
    }
    func commitPermissions(_ input: [String: Any]) throws -> String {
        let params = try object(input["params"]), port = try object(input["port"])
        guard let id = port["callId"] as? String, let changes = params["changes"] as? [[String: Any]], !changes.isEmpty else { throw LoopError.invalid }
        let encoded = try json(params)
        if let cached = permissionCommits[id] { guard cached.0 == encoded else { throw LoopError.invalid }; return cached.1 }
        var next = permissionRows, revisions: [[String: Any]] = [], chains = Set<String>()
        for change in changes {
            let scope = try object(change["scope"]), chain = try permissionChain(scope)
            let row = next[chain] ?? ["revision": "0", "permissions": []]
            guard chains.insert(chain).inserted, let expected = change["expectedRevision"] as? String,
                  expected == row["revision"] as? String, let revision = UInt64(expected), revision < UInt64.max,
                  let permissions = change["permissions"] as? [[String: Any]],
                  permissions.allSatisfy({ $0["invoker"] as? String == config["origin"] as? String }) else { throw LoopError.stale }
            let updated = String(revision + 1)
            next[chain] = ["revision": updated, "permissions": permissions]
            revisions.append(["scope": scope, "revision": updated])
        }
        let result = try json(["revisions": revisions])
        var commits = permissionCommits; commits[id] = (encoded, result)
        // Persist before publishing the new grants/epoch. Failure leaves the
        // in-memory authority unchanged; no ordinary signing record is saved.
        try permissionPersistence?.save(rows: next, commits: commits.mapValues { [$0.0, $0.1] })
        permissionRows = next; permissionCommits = commits
        counts["permissionWrites", default: 0] += 1; save()
        // Only a successful commit changes authorization. A duplicate call or
        // failed CAS must not cancel unrelated work or invalidate fresh permits.
        fence.authorizationChanged(); permits.removeAll()
        let cancel = cancelApproval; cancelApproval = nil; cancel?()
        if cancel != nil { presentedViewController?.dismiss(animated: true) }
        return result
    }
    func revokeForAcceptance() throws {
        guard config["revocation"] as? Bool == true else { throw LoopError.denied }
        _ = try commitPermissions(["port": ["callId": UUID().uuidString], "params": ["changes": [[
            "scope": ["origin": config["origin"]!, "chainId": "tbc:testnet"],
            "expectedRevision": permissionRows["tbc:testnet"]?["revision"] ?? "0", "permissions": []
        ]]]])
        counts["nativeRevocations", default: 0] += 1; save()
    }
    func approveJob(_ input: [String: Any]) async throws -> String {
        let scope=try object(input["scope"]), authority=try object(scope["authority"]), limits=try object(scope["limits"])
        guard jobConsent == nil, authority["chainId"] as? String == "tbc:testnet",
              authority["accountId"] as? String == signingAccounts[0]["accountId"] as? String,
              authority["origin"] as? String == config["origin"] as? String,
              let scopeHash=input["scopeHash"] as? String, scopeHash.count==64,
              let feeText=limits["maxTotalFee"] as? String, let maxFee=UInt64(feeText), maxFee<=200000,
              let expiryText=limits["expiresAt"] as? String, let expiry=parseInstant(expiryText), expiry>Date(),
              let items=scope["items"] as? [[String:Any]], !items.isEmpty, items.count<=250 else { throw LoopError.denied }
        let ticket=try fence.capture(timeoutSeconds:min(120,expiry.timeIntervalSinceNow),authorizationBound:true)
        counts["approvalUI",default:0]+=1; save()
        let accepted=await withCheckedContinuation { continuation in
            let controller=Rc11ApprovalController("TESTNET NFT MINT JOB — all items and recipients\n" + (try! json(scope))) { continuation.resume(returning:$0) }
            controller.modalPresentationStyle = .fullScreen; present(controller,animated:true)
        }
        guard accepted else { fence.cancel(ticket); return try json(["status":"rejected","scopeHash":scopeHash]) }
        try fence.check(ticket)
        let receipt:[String:Any]=["status":"approved","scopeHash":scopeHash,"approvalId":UUID().uuidString,"approvedAt":instant(),"expiresAt":expiryText]
        jobConsent=["scope":scope,"scopeHash":scopeHash,"receipt":receipt,"document":document]
        measure("approved",["kind":"nft-job","items":items.count]); counts["approved",default:0]+=1; save()
        return try json(receipt)
    }
    func authorizeJob(_ input:[String:Any]) throws -> String {
        guard let consent=jobConsent, consent["document"] as? String == document,
              try json(input["scope"]!) == json(consent["scope"]!),
              input["scopeHash"] as? String == consent["scopeHash"] as? String,
              try json(input["approval"]!) == json(consent["receipt"]!) else { throw LoopError.denied }
        let params=try object(input["params"]), binding=try object(params["binding"]), payload=try object(binding["payload"]), plan=try object(input["plan"]), pp=try object(plan["payload"])
        let approved=try object(consent["receipt"]), scope=try object(consent["scope"]), auth=try object(scope["authority"])
        guard payload["operationKind"] as? String == "transaction", payload["operationHash"] as? String == plan["planHash"] as? String,
              try json(params["preview"]!) == json(pp["preview"]!),
              payload["accountId"] as? String == auth["accountId"] as? String,
              payload["chainId"] as? String == "tbc:testnet", payload["origin"] as? String == auth["origin"] as? String,
              let expiryText=payload["expiresAt"] as? String, let expiry=parseInstant(expiryText), expiry>Date(),
              let until=approved["expiresAt"] as? String, let jobExpiry=parseInstant(until), expiry<=jobExpiry,
              let tasks=pp["signingTasks"] as? [[String:Any]], !tasks.isEmpty,
              tasks.allSatisfy({signingTaskMatchesAccount($0)}) else { throw LoopError.denied }
        let ticket=try fence.capture(timeoutSeconds:min(120,expiry.timeIntervalSinceNow),authorizationBound:true)
        let id=UUID().uuidString, receipt:[String:Any]=["status":"approved","approvalId":id,"approvalToken":UUID().uuidString,"bindingHash":binding["bindingHash"]!,"approvedAt":instant(),"expiresAt":expiryText]
        permits[id]=Permit(ticket:ticket,receipt:receipt,tasks:tasks,bindingPayload:payload,messageDigest:nil)
        measure("batch-credential",["tasks":tasks.count]); save(); return try json(receipt)
    }
    func approve(_ input: [String: Any]) async throws -> String {
        let params = try object(input["params"]), binding = try object(params["binding"]), payload = try object(binding["payload"]), presentation = try object(input["presentation"])
        guard presentation["trust"] as? String == "binding-verified", payload["origin"] as? String == config["origin"] as? String,
              let bindingHash = binding["bindingHash"] as? String, let expires = payload["expiresAt"] as? String,
              let expiry = parseInstant( expires), expiry > Date() else { throw LoopError.invalid }
        let ticket = try fence.capture(timeoutSeconds: min(120, expiry.timeIntervalSinceNow), authorizationBound: true)
        let label = config["ftTransfer"] is [String: Any] ? "REAL TESTNET · 1 raw C192 FT · max fee 1000\n" : "REAL TESTNET · self-send \(selfTransferAtomic) atomic · max fee 200\n"
        let profile = config["transactionProfile"] as? [String: Any]
        let heading = profile.map { "REAL TESTNET · \($0["title"] ?? "Test asset suite")\n" } ?? "REAL TESTNET · \(payload["method"] ?? "Request")\n"
        let terms = try object(presentation["businessTerms"])
        let identity = terms["status"] as? String == "known" ? "\nBound terms: " + (try json(terms["value"]!)) : ""
        var roleDisclosure = ""
        if controlledCoinMuSig {
            roleDisclosure += "\nPUBLIC FIXTURE ONLY: 2-of-2 MuSig administrator. Two public fixture keys in this App's isolated Keychain; this one approval authorizes both for this sign-only test. No independent remote participant or broadcast."
        }
        if let roles = presentation["signingRoles"] as? [String: Any] {
            guard roles["status"] as? String == "known",
                  let rows = roles["value"] as? [[String: Any]], !rows.isEmpty else { throw LoopError.denied }
            roleDisclosure += "\nFee account: \(signingAccounts[0]["address"]!)"
            for row in rows {
                let isPrimary=row["accountId"] as? String == signingAccounts[0]["accountId"] as? String
                let isAdmin=row["role"] as? String == "coin-admin"
                guard (isAdmin && isPrimary && realTestnet) ||
                      (hasSecondarySigner && row["role"] as? String == secondarySigningRole && row["accountId"] as? String == signingAccounts[1]["accountId"] as? String) else {throw LoopError.denied}
                let selected=signingAccounts[isPrimary ? 0 : 1],label=isAdmin ? "Coin administrator" : "Pool controller"
                let step = (row["stepId"] as? String).map { " (step \($0))" } ?? ""
                roleDisclosure += "\n\(label)\(step): \(selected["address"]!)"
            }
        }
        let warnings = (presentation["warnings"] as? [String] ?? []).map { code in
            code == "HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE"
                ? "Signing an HTLC claim reveals the preimage in the signed transaction, even before broadcast. Share signed bytes only when ready to disclose it."
                : code
        }
        let disclosures = warnings.isEmpty ? "" : "\nWarnings:\n" + warnings.joined(separator: "\n")
        let summary = (realTestnet ? heading : "TEST ONLY · no broadcast\n") + "\(config["origin"]!)" + roleDisclosure + "\n\n" + (try json(params["preview"]!)) + identity + disclosures
        counts["approvalUI", default: 0] += 1; save()
        return try await withCheckedThrowingContinuation { continuation in
            guard cancelApproval == nil else { continuation.resume(throwing: LoopError.invalid); return }
            cancelApproval = { continuation.resume(throwing: LoopError.stale) }
            let alert = UIAlertController(title: "Review native Kit request", message: summary, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Reject", style: .cancel) { _ in
                guard self.cancelApproval != nil else { return }; self.cancelApproval = nil
                self.fence.cancel(ticket); self.counts["rejected", default: 0] += 1
                continuation.resume(returning: try! json(["status": "rejected", "bindingHash": bindingHash, "rejectedAt": instant()]))
            })
            let permission = payload["operationKind"] as? String == "permission"
            alert.addAction(UIAlertAction(title: permission ? "Allow test permissions" : "Approve test signing", style: .default) { _ in
                guard self.cancelApproval != nil else { return }; self.cancelApproval = nil
                do {
                    try self.fence.check(ticket)
                    self.measure("approved")
                    let approvalID = UUID().uuidString
                    let receipt: [String: Any] = ["status": "approved", "approvalId": approvalID, "approvalToken": UUID().uuidString, "bindingHash": bindingHash, "approvedAt": instant(), "expiresAt": expires]
                    let preview = try object(params["preview"])
                    if !permission {
                        var permit = Permit(ticket: ticket, receipt: receipt, tasks: input["signingTasks"] as? [[String: Any]] ?? [], bindingPayload: payload, messageDigest: preview["digest"] as? String)
                        for material in input["reviewedMaterials"] as? [[String:Any]] ?? [] {
                            guard let taskID = material["taskId"] as? String, permit.reviewedMaterialCommitments[taskID] == nil else { throw LoopError.denied }
                            permit.reviewedMaterialCommitments[taskID] = try permitCommitment(material)
                        }
                        if let plan = input["walletActionPlan"] as? [String: Any] {
                            guard plan["planHash"] as? String == payload["operationHash"] as? String else { throw LoopError.denied }
                            permit.actionTaskCommitment = try permitCommitment(object(object(plan["payload"])["task"]))
                        }
                        if payload["operationKind"] as? String == "workflow" {
                            let plan = try object(input["workflowPlan"])
                            guard plan["workflowPlanHash"] as? String == payload["operationHash"] as? String else { throw LoopError.denied }
                            // Retain a private continuation projection, not a second copy of secret-bearing reviewed tasks.
                            var projection = plan
                            var projectedPayload = try object(plan["payload"])
                            for task in projectedPayload["reviewedTransactionTasks"] as? [[String: Any]] ?? [] {
                                permit.reviewedTaskCommitments.insert(try permitCommitment(task))
                            }
                            projectedPayload.removeValue(forKey: "reviewedTransactionTasks")
                            projection["payload"] = projectedPayload
                            permit.workflowPlan = projection
                            permit.workflowTasks = try object(plan["payload"])["immediateSigningTasks"] as? [[String: Any]] ?? []
                        }
                        self.permits[approvalID] = permit
                    }
                    self.counts["approved", default: 0] += 1; continuation.resume(returning: try json(receipt))
                } catch { continuation.resume(throwing: LoopError.stale) }
            })
            let revocation = config["revocation"] as? Bool == true
            alert.addAction(UIAlertAction(title: revocation ? "Revoke permissions (test)" : "Navigate instead (test)", style: .destructive) { _ in
                if revocation {
                    do { try self.revokeForAcceptance() }
                    catch { self.invalidate() }
                } else {
                    self.invalidate(); self.web.load(URLRequest(url: URL(string: (self.config["origin"] as! String) + "/second")!))
                }
            })
            present(alert, animated: true)
        }
    }
    func signingTaskMatchesAccount(_ task: [String: Any]) -> Bool {
        func lowerHex(_ value: String, _ size: Int) -> Bool {
            value.utf8.count == size && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
        guard let account = signingAccounts.first(where: { $0["accountId"] as? String == task["accountId"] as? String }),
              let accountID = account["accountId"] as? String, !accountID.isEmpty,
              task["accountId"] as? String == accountID,
              let key = account["publicKey"] as? String, lowerHex(key, 66), key.hasPrefix("02") || key.hasPrefix("03"),
              let digest = task["digest"] as? String, lowerHex(digest, 64),
              let encoding = task["signatureEncoding"] as? String,
              let algorithm = task["algorithm"] as? String else { return false }
        if task["purpose"] as? String == "transaction" {
            guard task["sighashType"] as? Int == 65 else { return false }
            if algorithm == "secp256k1-schnorr-bip340" {
                return encoding == "schnorr64" && task["publicKey"] as? String == String(key.dropFirst(2))
            }
            return algorithm == "secp256k1-ecdsa-sha256d" && encoding == "compact64" && task["publicKey"] as? String == key
        }
        return ["message", "typedData"].contains(task["purpose"] as? String ?? "") &&
            algorithm == "secp256k1-recoverable-ecdsa-sha256d" && encoding == "compact65-recoverable" && task["publicKey"] as? String == key
    }
    // Only a successful native Engine validation can extend an already approved
    // transaction. Page/JS signer input alone cannot register a new task.
    func acceptValidatedContinuation(_ input: String, _ output: String) throws {
        let p = try object(parse(input)), envelope = try object(parse(output))
        guard p["phase"] as? String == "finalized", let pending = p["pending"] as? [String: Any],
              envelope["ok"] as? Bool == true, (envelope["result"] as? [String: Any])?["valid"] as? Bool == true else { return }
        let approval = try object(p["approval"]), continuation = try object(pending["continuation"])
        if let id = approval["approvalId"] as? String, var permit = permits[id], let workflowPlan = permit.workflowPlan {
            let entries = try object(workflowPlan["payload"])["transactionPlans"] as? [[String: Any]] ?? []
            let child = try object(p["plan"])
            guard let entry = try entries.first(where: { try json($0["plan"]!) == json(child) }), let step = entry["stepId"] as? String,
                  try json(approval) == json(permit.receipt),
                  continuation["approvalId"] as? String == id, continuation["bindingHash"] as? String == permit.receipt["bindingHash"] as? String,
                  p["requestHash"] as? String == (try object(child["payload"])["requestHash"] as? String),
                  continuation["requestHash"] as? String == p["requestHash"] as? String,
                  continuation["planHash"] as? String == child["planHash"] as? String,
                  let stage = continuation["stage"] as? Int, stage == permit.workflowStages[step, default: 0] + 1,
                  let tasks = pending["signingRequests"] as? [[String: Any]], !tasks.isEmpty else { throw LoopError.denied }
            try fence.check(permit.ticket)
            let previous = permit.workflowTasks.filter { $0["stepId"] as? String == step }
            guard previous.allSatisfy({ permit.used.contains(step + ":" + (($0["task"] as? [String: Any])?["taskId"] as? String ?? "")) }) else { throw LoopError.denied }
            var ids = Set(previous.compactMap { ($0["task"] as? [String: Any])?["taskId"] as? String })
            for task in tasks {
                guard let taskID = task["taskId"] as? String, ids.insert(taskID).inserted,
                      signingTaskMatchesAccount(task) else { throw LoopError.denied }
                permit.workflowTasks.append(["stepId": step, "task": task])
            }
            permit.workflowStages[step] = stage; permits[id] = permit
            counts["validatedWorkflowContinuation", default: 0] += 1; return
        }
        guard let id = approval["approvalId"] as? String, var permit = permits[id],
              try json(approval) == json(permit.receipt),
              p["requestHash"] as? String == permit.bindingPayload["requestHash"] as? String,
              (p["plan"] as? [String: Any])?["planHash"] as? String == permit.bindingPayload["operationHash"] as? String,
              continuation["approvalId"] as? String == id,
              continuation["bindingHash"] as? String == permit.receipt["bindingHash"] as? String,
              continuation["requestHash"] as? String == permit.bindingPayload["requestHash"] as? String,
              continuation["planHash"] as? String == permit.bindingPayload["operationHash"] as? String,
              let stage = continuation["stage"] as? Int, stage == permit.stage + 1,
              let tasks = pending["signingRequests"] as? [[String: Any]], !tasks.isEmpty,
              permit.tasks.allSatisfy({ permit.used.contains($0["taskId"] as? String ?? "") }) else { throw LoopError.denied }
        try fence.check(permit.ticket)
        var ids = Set(permit.tasks.compactMap { $0["taskId"] as? String })
        for task in tasks {
            guard let taskID = task["taskId"] as? String, ids.insert(taskID).inserted,
                  signingTaskMatchesAccount(task) else { throw LoopError.denied }
        }
        permit.tasks += tasks; permit.stage = stage; permits[id] = permit
        counts["validatedContinuation", default: 0] += 1
    }
    func reviewed(_ input: [String: Any], stageOnly: Bool = false) async throws -> String {
        let params=try object(input["params"]),task=try object(params["task"]),receipt=try object(params["approval"]),material=try object(input["material"])
        guard realTestnet,let custody=testnetVault,let id=receipt["approvalId"] as? String,var permit=permits[id],
              try json(receipt)==json(permit.receipt),let taskID=task["taskId"] as? String,
              task["purpose"] as? String == "reviewedTransaction",
              task["publicKey"] as? String == (config["account"] as? [String:Any])?["publicKey"] as? String,
              task["accountId"] as? String == (config["account"] as? [String:Any])?["accountId"] as? String,
              permit.bindingPayload["origin"] as? String == config["origin"] as? String,
              task["contextHash"] as? String == permit.bindingPayload["contextHash"] as? String,
              task["chainId"] as? String == (config["account"] as? [String:Any])?["chainId"] as? String else { throw LoopError.denied }
        var onceID=taskID
        if let plan=permit.workflowPlan {
            let evidence=try object(input[stageOnly ? "evidence" : "workflowTask"])
            guard evidence["workflowPlanHash"] as? String == plan["workflowPlanHash"] as? String,
                  evidence["bindingHash"] as? String == receipt["bindingHash"] as? String,
                  let step=evidence["stepId"] as? String,try json(object(evidence["task"]))==json(task),
                  permit.reviewedTaskCommitments.contains(try permitCommitment(task)) else {throw LoopError.denied}
            onceID=step+":"+taskID
        } else {guard let expected=permit.actionTaskCommitment,try expected==permitCommitment(task) else {throw LoopError.denied}}
        guard let expectedMaterial=permit.reviewedMaterialCommitments[taskID],
              let format=material["format"] as? String,["raw","associated"].contains(format),
              let requestMaterial=material["request"],
              let policyMaterial=material["policyMaterial"] as? [String:Any],
              let resolvedOutputs=policyMaterial["resolvedOutputs"] as? [[String:Any]],
              let taskPolicy=task["policyMaterial"],try json(taskPolicy)==json(policyMaterial),
              try expectedMaterial==permitCommitment(["taskId":taskID,"format":format,"request":requestMaterial,"policyMaterial":policyMaterial]) else {throw LoopError.denied}
        let request=try object(material["request"]),publicKey=task["publicKey"] as! String
        let count=format=="raw" ? (request["txraws"] as? [Any])?.count ?? 0 : 1+((request["inputs"] as? [Any])?.count ?? 0)
        guard (1...32).contains(count) else {throw LoopError.invalid}
        if stageOnly {
            let port=try object(input["port"]),evidence=try object(input["evidence"])
            let evidenceTask=try object(evidence["task"]),receivedStage=try object(input["stage"])
            guard let index=input["transactionIndex"] as? Int,index>=0,index<count,
                  let callID=port["callId"] as? String,evidence["callId"] as? String == callID,
                  port["operation"] as? String == "reviewedTransaction.execute",
                  evidence["bindingHash"] as? String == receipt["bindingHash"] as? String,
                  try json(evidenceTask) == json(task),try json(object(port["params"])) == json(params),
                  let receivedTasks=input["tasks"] as? [[String:Any]],
                  let until=receipt["expiresAt"] as? String,let expiry=parseInstant(until),expiry>Date(),
                  let roles=task["signingRoles"] as? [[String:Any]],roles.count==1,
                  roles[0]["role"] as? String == "coin-admin" else {throw LoopError.denied}
            let administrator=try object(roles[0]["account"])
            guard try signingAccounts.filter({$0["accountId"] as? String == administrator["accountId"] as? String}).contains(where:{try json($0)==json(administrator)}) else {throw LoopError.denied}
            if index==0 {
                guard !permit.used.contains(onceID) else {throw LoopError.denied}
                try fence.startBoundTaskOnce(permit.ticket,taskID:onceID) {}
                permit.used.insert(onceID);permit.reviewedParents[onceID]=[];permit.reviewedCallIDs[onceID]=callID
            }
            guard let parents=permit.reviewedParents[onceID],parents.count==index,permit.reviewedCallIDs[onceID]==callID else {throw LoopError.denied}
            // Consume before the first suspension. A failed or concurrent call
            // cannot reuse this stage even when the approval is still active.
            try fence.startBoundTaskOnce(permit.ticket,taskID:"reviewed-stage:\(onceID):\(index)") {}
            permits[id]=permit
            var completed=false
            defer {
                if !completed,var current=permits[id] {
                    current.reviewedParents.removeValue(forKey:onceID);current.reviewedCallIDs.removeValue(forKey:onceID);permits[id]=current
                }
            }
            let stage=try object(parse(await keylessEngine.callEnvelope(.prepareReviewedStage,canonicalInput:json(["format":format,"request":request,"publicKey":publicKey,"transactionIndex":index,"previousTransactions":format == "associated" ? parents : [],"resolvedOutputs":resolvedOutputs]))))
            try fence.check(permit.ticket)
            guard try json(stage)==json(receivedStage),let digests=stage["digests"] as? [String],
                  let indexes=stage["signingInputIndexes"] as? [Int],let inputs=stage["inputs"] as? [[String:Any]],
                  !digests.isEmpty,digests.count<=1000,indexes.count==digests.count else {throw LoopError.denied}
            var expectedTasks:[[String:Any]]=[]
            for (slot,digest) in digests.enumerated() {
                let n=indexes[slot];guard n>=0,n<inputs.count else {throw LoopError.denied}
                let marked=inputs[n]["signingPublicKey"] as? String
                let account=marked == nil ? try object(config["account"]) : administrator
                guard let key=account["publicKey"] as? String,let accountID=account["accountId"] as? String else {throw LoopError.denied}
                let selected=marked ?? key,algorithm=selected.count==64 ? "secp256k1-schnorr" : "secp256k1-ecdsa"
                guard selected==key || selected==String(key.dropFirst(2)),marked==nil || inputs[n]["scriptSigType"] as? String == "tbc20-stablecoin" else {throw LoopError.denied}
                let expected:[String:Any]=["inputIndex":n,"digest":digest,"publicKey":selected,"algorithm":algorithm]
                if let engineTasks=stage["signingTasks"] as? [[String:Any]] {
                    guard engineTasks.count==digests.count,try json(engineTasks[slot])==json(expected) else {throw LoopError.denied}
                } else {guard marked==nil else {throw LoopError.denied}}
                var task=expected;task["accountId"]=accountID;expectedTasks.append(task)
            }
            guard try json(expectedTasks)==json(receivedTasks) else {throw LoopError.denied}
            var signatures:[String]=[]
            for (slot,item) in expectedTasks.enumerated() {
                let encoding=item["algorithm"] as? String == "secp256k1-schnorr" ? "schnorr64" : "compact64"
                let primary=item["accountId"] as? String == task["accountId"] as? String
                let selected=primary ? custody : testnetAdminVault
                guard let selected,primary || realCoinAdmin else {throw LoopError.denied}
                let signature=try fence.startBoundTaskOnce(permit.ticket,taskID:"reviewed:\(onceID):\(index):\(slot)"){try selected.sign(digest:item["digest"] as! String,encoding:encoding)}
                signatures.append(signature);counts["vaultSigns",default:0]+=1
                counts[primary ? "feeVaultSigns" : "adminVaultSigns",default:0]+=1
            }
            let result=try object(parse(await keylessEngine.callEnvelope(.finalizeReviewedStage,canonicalInput:json(["stage":stage,"signatures":signatures,"signatureEncoding":"compact64"]))))
            try fence.check(permit.ticket)
            guard let raw=result["txraw"] as? String,var current=permits[id],try json(current.receipt)==json(receipt) else {throw LoopError.denied}
            if format == "raw" {
                guard let original=request["txraws"] as? [String],raw==original[index],
                      let detached=result["sigs"] as? [String],detached.count==inputs.count,
                      detached.allSatisfy({$0.range(of:"^(?:[0-9a-f]{2}){1,512}$",options:.regularExpression) != nil}) else {throw LoopError.denied}
            }
            if index+1==count {current.reviewedParents.removeValue(forKey:onceID);current.reviewedCallIDs.removeValue(forKey:onceID)}
            else {current.reviewedParents[onceID]=parents+[raw]}
            permits[id]=current
            completed=true
            return try json(signatures)
        }
        guard !permit.used.contains(onceID) else {throw LoopError.denied}
        try fence.startBoundTaskOnce(permit.ticket,taskID:onceID) {}
        permit.used.insert(onceID);permits[id]=permit
        var raws:[String]=[],matrix:[[String]]=[]
        for index in 0..<count {
            try fence.check(permit.ticket)
            let stage=try object(parse(await keylessEngine.callEnvelope(.prepareReviewedStage,canonicalInput:json(["format":format,"request":request,"publicKey":publicKey,"transactionIndex":index,"previousTransactions":format=="associated" ? raws : [],"resolvedOutputs":resolvedOutputs]))))
            guard let digests=stage["digests"] as? [String],!digests.isEmpty,digests.count<=1000 else {throw LoopError.invalid}
            var signatures:[String]=[]
            for (slot,digest) in digests.enumerated() {
                let signStart=ProcessInfo.processInfo.systemUptime
                let sig=try fence.startBoundTaskOnce(permit.ticket,taskID:"reviewed:\(onceID):\(index):\(slot)"){try custody.sign(digest:digest,encoding:"compact64")}
                signatures.append(sig);counts["vaultSigns",default:0]+=1
                measure("signature",["nativeMs":(ProcessInfo.processInfo.systemUptime-signStart)*1000,"inputIndex":slot])
            }
            let result=try object(parse(await keylessEngine.callEnvelope(.finalizeReviewedStage,canonicalInput:json(["stage":stage,"signatures":signatures,"signatureEncoding":"compact64"]))))
            try fence.check(permit.ticket)
            guard let raw=result["txraw"] as? String,let sigs=result["sigs"] as? [String] else {throw LoopError.invalid}
            raws.append(raw);matrix.append(sigs)
        }
        return try json(format=="raw" ? ["sigs":matrix] : ["txraws":raws])
    }
    func crypt(_ input: [String: Any]) throws -> String {
        let params = try object(input["params"]), task = try object(params["task"]), receipt = try object(params["approval"])
        guard realTestnet, let custody = testnetVault, let id = receipt["approvalId"] as? String,
              var permit = permits[id], try json(receipt) == json(permit.receipt),
              let taskID = task["taskId"] as? String, let purpose = task["purpose"] as? String,
              ["encrypt","decrypt"].contains(purpose), task["algorithm"] as? String == "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1",
              task["publicKey"] as? String == (config["account"] as? [String:Any])?["publicKey"] as? String,
              task["accountId"] as? String == (config["account"] as? [String:Any])?["accountId"] as? String,
              task["origin"] as? String == config["origin"] as? String else { throw LoopError.denied }
        var onceID = taskID
        if let plan = permit.workflowPlan {
            let evidence = try object(input["workflowTask"])
            guard evidence["workflowPlanHash"] as? String == plan["workflowPlanHash"] as? String,
                  evidence["bindingHash"] as? String == receipt["bindingHash"] as? String,
                  let step = evidence["stepId"] as? String, try json(evidence["task"]!) == json(task),
                  let allowed = try object(plan["payload"])["cryptoTasks"] as? [[String:Any]],
                  try allowed.contains(where:{try json($0)==json(task)}) else { throw LoopError.denied }
            onceID = step + ":" + taskID
        } else { guard let expected = permit.actionTaskCommitment, try expected==permitCommitment(task) else { throw LoopError.denied } }
        guard !permit.used.contains(onceID) else { throw LoopError.denied }
        let decrypt = purpose == "decrypt"
        var bytes: [UInt8]
        if decrypt { guard let raw = task["ciphertext"] as? String, let data = Data(base64Encoded:raw) else { throw LoopError.invalid };bytes=Array(data) }
        else {
            let message = try object(task["message"]);guard let data = message["data"] as? String else { throw LoopError.invalid }
            switch message["encoding"] as? String {
            case "utf8": bytes=Array(data.utf8)
            case "base64": guard let value=Data(base64Encoded:data) else { throw LoopError.invalid };bytes=Array(value)
            case "hex":
                guard data.count % 2 == 0 else { throw LoopError.invalid };bytes=[]
                var index=data.startIndex;while index<data.endIndex {let end=data.index(index,offsetBy:2);guard let byte=UInt8(data[index..<end],radix:16) else {throw LoopError.invalid};bytes.append(byte);index=end}
            default: throw LoopError.invalid
            }
        }
        defer { for index in bytes.indices { bytes[index]=0 } }
        var output = try fence.startBoundTaskOnce(permit.ticket,taskID:onceID) { try custody.crypt(input:bytes,decrypt:decrypt) }
        defer { for index in output.indices { output[index]=0 } }
        permit.used.insert(onceID);permits[id]=permit;counts["vaultCrypto",default:0]+=1
        var result:[String:Any] = ["taskId":taskID,"algorithm":task["algorithm"]!]
        if decrypt { result["message"]=["encoding":"base64","data":Data(output).base64EncodedString()] }
        else { result["ciphertext"]=Data(output).base64EncodedString() }
        return try json(result)
    }
    func sign(_ input: [String: Any]) throws -> String {
        let params = try object(input["params"]), approval = try object(params["approval"]), task = try object(params["task"])
        guard let id = approval["approvalId"] as? String, var permit = permits[id],
              let taskID = task["taskId"] as? String, let digest = task["digest"] as? String,
              let encoding = task["signatureEncoding"] as? String, !permit.used.contains(taskID),
              approval["approvalToken"] as? String == permit.receipt["approvalToken"] as? String,
              approval["bindingHash"] as? String == permit.receipt["bindingHash"] as? String,
              signingTaskMatchesAccount(task),
              let until = permit.receipt["expiresAt"] as? String, let expiry = parseInstant( until), expiry > Date() else { throw LoopError.denied }
        var onceID = taskID
        if let workflowPlan = permit.workflowPlan {
            let evidence = try object(input["workflowTask"])
            guard evidence["workflowPlanHash"] as? String == workflowPlan["workflowPlanHash"] as? String,
                  evidence["bindingHash"] as? String == permit.receipt["bindingHash"] as? String,
                  let step = evidence["stepId"] as? String,
                  try json(evidence["task"]!) == json(task) else { throw LoopError.denied }
            onceID = step + ":" + taskID
            let exact = try permit.workflowTasks.contains {
                guard $0["stepId"] as? String == step, let expected = $0["task"] else { return false }
                return try json(expected) == json(task)
            }
            if !exact {
                // Deferred digests are derived and checked by the trusted Kit
                // Core/Host. This private callback is inaccessible to the page.
                let deferred = try object(workflowPlan["payload"])["deferredSigningTasks"] as? [[String: Any]] ?? []
                guard deferred.contains(where: { $0["targetStepId"] as? String == step && $0["taskId"] as? String == taskID && $0["purpose"] as? String == task["purpose"] as? String && $0["publicKey"] as? String == task["publicKey"] as? String }),
                      task["origin"] as? String == config["origin"] as? String,
                      task["accountId"] as? String == (config["account"] as? [String: Any])?["accountId"] as? String,
                      encoding == "compact65-recoverable" else { throw LoopError.denied }
            }
        } else if permit.tasks.isEmpty {
            let purpose = permit.bindingPayload["method"] as? String == "tbc_signTypedData" ? "typedData" : "message"
            guard ["tbc_signMessage", "tbc_signTypedData"].contains(permit.bindingPayload["method"] as? String ?? ""),
                  task["purpose"] as? String == purpose, task["origin"] as? String == config["origin"] as? String,
                  task["accountId"] as? String == (config["account"] as? [String: Any])?["accountId"] as? String,
                  digest == permit.messageDigest, encoding == "compact65-recoverable" else { throw LoopError.denied }
        } else { guard try permit.tasks.contains(where: { try json($0) == json(task) }) else { throw LoopError.denied } }
        // MainActor is also the Vault-start executor; there is no unguarded hop.
        func ordinarySignature() throws -> String { try fence.startBoundTaskOnce(permit.ticket, taskID: onceID) {
            if self.realTestnet {
                if self.realCoinAdmin, task["accountId"] as? String == self.signingAccounts[1]["accountId"] as? String {
                    guard task["purpose"] as? String == "transaction", let admin = self.testnetAdminVault else { throw LoopError.denied }
                    return try admin.sign(digest: digest, encoding: encoding)
                }
                guard task["accountId"] as? String == self.signingAccounts[0]["accountId"] as? String,
                      let custody = self.testnetVault else { throw LoopError.denied }
                return try custody.sign(digest: digest, encoding: encoding)
            }
            if self.controlledSecondarySigner, task["accountId"] as? String == self.signingAccounts[1]["accountId"] as? String {
                guard task["purpose"] as? String == "transaction", let admin = self.adminVault else { throw LoopError.denied }
                return try admin.sign(digest: digest, encoding: encoding)
            }
            guard task["accountId"] as? String == (self.config["account"] as? [String: Any])?["accountId"] as? String else { throw LoopError.denied }
            guard let vault = self.vault else { throw LoopError.vault }
            return try vault.sign(digest: digest, encoding: encoding)
        } }
        let signStart=ProcessInfo.processInfo.systemUptime
        let signature: String
#if TBC_SIGNER_MUSIG
        if controlledCoinMuSig, task["accountId"] as? String == signingAccounts[1]["accountId"] as? String {
            signature = try signControlledMuSig(task: task, permit: permit, approvalID: id, onceID: onceID)
        } else { signature = try ordinarySignature() }
#else
        signature = try ordinarySignature()
#endif
        measure("signature",["taskId":taskID,"nativeMs":(ProcessInfo.processInfo.systemUptime-signStart)*1000]);
        permit.used.insert(onceID); permits[id] = permit; counts["vaultSigns", default: 0] += 1
        if hasSecondarySigner {
            let roleCounter = task["accountId"] as? String == signingAccounts[1]["accountId"] as? String ? (controlledPoolController ? "controllerVaultSigns" : "adminVaultSigns") : "feeVaultSigns"
            counts[roleCounter, default: 0] += 1
        }
        return try json(["taskId": taskID, "signatureEncoding": encoding, "signature": signature])
    }
}

@main @MainActor final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds); w.rootViewController = WalletController(); w.makeKeyAndVisible(); window = w; return true
    }
    func applicationWillResignActive(_ application: UIApplication) { (window?.rootViewController as? WalletController)?.invalidate() }
}
