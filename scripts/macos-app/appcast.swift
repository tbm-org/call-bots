// Build-time XML handling. Foundation keeps release-note CDATA and XML
// namespaces separate from real enclosures; no XML parser ships in the app.
import Foundation

let sparkleNamespace = "http://www.andymatuschak.org/xml-namespaces/sparkle"

func children(_ node: XMLNode, named name: String, uri: String? = nil) -> [XMLElement] {
  (node.children ?? []).compactMap { $0 as? XMLElement }.filter {
    $0.localName == name && ($0.uri ?? "") == (uri ?? "")
  }
}

func enclosures(_ item: XMLNode) -> [(XMLElement, Bool)] {
  children(item, named: "enclosure").map { ($0, false) } +
    children(item, named: "deltas", uri: sparkleNamespace).flatMap {
      children($0, named: "enclosure").map { ($0, true) }
    }
}

func fail(_ message: String) throws -> Never {
  throw NSError(domain: "CallBotsAppcast", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message])
}

do {
  let args = CommandLine.arguments
  guard args.count >= 3 else { try fail("usage: appcast read INPUT | rewrite INPUT URL_MAP OUTPUT") }
  let document = try XMLDocument(contentsOf: URL(fileURLWithPath: args[2]),
                                options: [.nodePreserveAll, .nodeLoadExternalEntitiesNever])
  guard document.dtd == nil else { try fail("An appcast must not contain a DTD") }
  let items = try document.nodes(forXPath: "/rss/channel/item")
  guard !items.isEmpty else { try fail("The appcast has no update items") }
  if args[1] == "read", args.count == 3 {
    let values: [[String: Any]] = try items.map { item in
      let versions = children(item, named: "version", uri: sparkleNamespace)
      guard versions.count == 1, let version = versions[0].stringValue else { try fail("An update item must have one version") }
      let downloads: [[String: Any]] = enclosures(item).map { element, isDelta in
        var attributes: [String: String] = [:]
        for attribute in element.attributes ?? [] {
          if let name = attribute.localName, let value = attribute.stringValue {
            attributes[attribute.uri == sparkleNamespace ? "sparkle:\(name)" : name] = value
          }
        }
        return ["attributes": attributes, "isDelta": isDelta]
      }
      return ["version": version, "enclosures": downloads]
    }
    let data = try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
  } else if args[1] == "rewrite", args.count == 5 {
    let data = try Data(contentsOf: URL(fileURLWithPath: args[3]))
    guard let mapping = try JSONSerialization.jsonObject(with: data) as? [String: String] else { try fail("Invalid URL map") }
    var changed = Set<String>()
    for item in items {
      for (element, _) in enclosures(item) {
        guard let attribute = element.attribute(forName: "url"),
              let old = attribute.stringValue, let replacement = mapping[old] else { continue }
        attribute.stringValue = replacement
        changed.insert(old)
      }
    }
    guard changed == Set(mapping.keys) else { try fail("Not every download URL was found in the appcast") }
    try document.xmlData.write(to: URL(fileURLWithPath: args[4]), options: .atomic)
  } else { try fail("Unknown appcast command") }
} catch {
  FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
  exit(1)
}
