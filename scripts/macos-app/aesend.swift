// aesend — Apple Events to one Chrome process, by pid.
//
// Chrome answers AppleScript one process per bundle id: `tell application id`
// resolves to whichever process LaunchServices lists first, and JavaScript
// for Automation's Application(pid) was measured to do the same — both pids
// answered from the same process. The Apple Event Manager itself addresses a
// process by pid without ambiguity; it is the script layers that lose it. So
// this sends the events the guest driver needs with the target descriptor
// built from the pid, and nothing else in between.
//
// Every command prints its answer on stdout and exits 0, or prints the Apple
// Event error on stderr and exits 1. Errors keep their numbers (-1743 is the
// Automation permission, -600 no such process, -1728 no such object) so the
// caller can tell them apart.
//
//   aesend <pid> count                      number of windows
//   aesend <pid> window-id <index>          id of the window at 1-based index
//   aesend <pid> new-window                 make a window; prints its id
//   aesend <pid> url <window-id>            URL of the window's active tab
//   aesend <pid> set-url <window-id> <url>
//   aesend <pid> exec <window-id>           JavaScript on stdin; prints the result
//   aesend <pid> minimize <window-id>
//   aesend <pid> bounds <window-id> <x> <y> <w> <h>
//   aesend <pid> get-bounds <window-id>     x y w h
//   aesend <pid> close <window-id>
//   aesend <pid> hide                       hide the application (all its windows)
//   aesend <pid> unhide                     show it again
//   aesend <pid> visibility                 actual application visibility
//   aesend <pid> quit

import AppKit
import CoreServices
import Foundation

func fourCC(_ s: String) -> OSType {
  var result: OSType = 0
  for scalar in s.unicodeScalars { result = (result << 8) | OSType(scalar.value & 0xff) }
  return result
}

let keyDirectObject = fourCC("----")
let keyData = fourCC("data")
let keyWant = fourCC("want")
let keyForm = fourCC("form")
let keySeld = fourCC("seld")
let keyFrom = fourCC("from")
let keyClass = fourCC("kocl")
let keyErrorNumber = fourCC("errn")
let keyErrorString = fourCC("errs")

let typeObjectSpecifier = fourCC("obj ")
let typeWindow = fourCC("cwin")
let typeProperty = fourCC("prop")
let formUniqueID = fourCC("ID  ")
let formAbsolutePosition = fourCC("indx")
let formProperty = fourCC("prop")
let propActiveTab = fourCC("acTa")
let propURL = fourCC("URL ")
let propID = fourCC("ID  ")
let propMinimized = fourCC("pmnd")
let propBounds = fourCC("pbnd")

let classCore = fourCC("core")
let eventGetData = fourCC("getd")
let eventSetData = fourCC("setd")
let eventCreate = fourCC("crel")
let eventCount = fourCC("cnte")
let eventClose = fourCC("clos")
let classChrome = fourCC("CrSu")
let eventExecute = fourCC("ExJa")
let paramJavascript = fourCC("JvSc")
let classApp = fourCC("aevt")
let eventQuit = fourCC("quit")

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func specifier(want: OSType, form: OSType, seld: NSAppleEventDescriptor, from: NSAppleEventDescriptor) -> NSAppleEventDescriptor {
  let record = NSAppleEventDescriptor.record()
  record.setDescriptor(NSAppleEventDescriptor(typeCode: want), forKeyword: keyWant)
  record.setDescriptor(NSAppleEventDescriptor(enumCode: form), forKeyword: keyForm)
  record.setDescriptor(seld, forKeyword: keySeld)
  record.setDescriptor(from, forKeyword: keyFrom)
  guard let spec = record.coerce(toDescriptorType: typeObjectSpecifier) else { fail("could not build an object specifier") }
  return spec
}

// Chrome's window and tab ids are text in its dictionary, so the unique-id
// form carries a string; an integer there is "no such object".
func windowById(_ id: String) -> NSAppleEventDescriptor {
  specifier(want: typeWindow, form: formUniqueID, seld: NSAppleEventDescriptor(string: id), from: NSAppleEventDescriptor.null())
}

func windowByIndex(_ index: Int32) -> NSAppleEventDescriptor {
  specifier(want: typeWindow, form: formAbsolutePosition, seld: NSAppleEventDescriptor(int32: index), from: NSAppleEventDescriptor.null())
}

func property(_ code: OSType, of container: NSAppleEventDescriptor) -> NSAppleEventDescriptor {
  specifier(want: typeProperty, form: formProperty, seld: NSAppleEventDescriptor(typeCode: code), from: container)
}

func activeTab(ofWindow id: String) -> NSAppleEventDescriptor {
  property(propActiveTab, of: windowById(id))
}

let arguments = CommandLine.arguments
guard arguments.count >= 3, let pid = Int32(arguments[1]) else {
  fail("usage: aesend <pid> <command> [args]")
}
let target = NSAppleEventDescriptor(processIdentifier: pid)
let timeoutSeconds: TimeInterval = Double(ProcessInfo.processInfo.environment["AESEND_TIMEOUT"] ?? "") ?? 10
var automationPermissionChecked = false

// Asking through the consent API is deliberate. A freshly installed Call Bots
// has no Automation decision yet, and sending with `.neverInteract` alone
// returns -1743 without ever giving the user a chance to allow the browser.
// This helper is a short-lived subprocess, so the potentially blocking prompt
// never stalls the app's main thread.
func requireAutomationPermission() {
  if automationPermissionChecked { return }
  guard let address = target.aeDesc else { fail("could not address the Call Bots browser") }
  let status = AEDeterminePermissionToAutomateTarget(address, typeWildCard, typeWildCard, true)
  if status != noErr { fail("Apple Event error \(status) Automation permission was not granted") }
  automationPermissionChecked = true
}

func send(_ eventClass: OSType, _ eventID: OSType, params: [(OSType, NSAppleEventDescriptor)]) -> NSAppleEventDescriptor {
  requireAutomationPermission()
  let event = NSAppleEventDescriptor(
    eventClass: eventClass, eventID: eventID, targetDescriptor: target,
    returnID: Int16(kAutoGenerateReturnID), transactionID: Int32(kAnyTransactionID))
  for (keyword, value) in params { event.setParam(value, forKeyword: keyword) }
  do {
    let reply = try event.sendEvent(options: [.waitForReply, .neverInteract], timeout: timeoutSeconds)
    if let number = reply.paramDescriptor(forKeyword: keyErrorNumber), number.int32Value != 0 {
      let text = reply.paramDescriptor(forKeyword: keyErrorString)?.stringValue ?? ""
      fail("Apple Event error \(number.int32Value) \(text)")
    }
    return reply
  } catch {
    let nsError = error as NSError
    fail("Apple Event error \(nsError.code) \(nsError.localizedDescription)")
  }
}

func answer(_ reply: NSAppleEventDescriptor) -> String {
  guard let result = reply.paramDescriptor(forKeyword: keyDirectObject) else { return "" }
  if let text = result.coerce(toDescriptorType: fourCC("utxt"))?.stringValue { return text }
  return result.stringValue ?? ""
}

func int32Arg(_ index: Int, _ what: String) -> Int32 {
  guard arguments.count > index, let value = Int32(arguments[index]) else { fail("\(what) must be a number") }
  return value
}

func idArg(_ index: Int) -> String {
  guard arguments.count > index, !arguments[index].isEmpty else { fail("window id missing") }
  return arguments[index]
}

func idAnswer(_ reply: NSAppleEventDescriptor) -> String {
  guard let result = reply.paramDescriptor(forKeyword: keyDirectObject) else { return "" }
  return result.stringValue ?? String(result.int32Value)
}

let command = arguments[2]
switch command {
case "count":
  let reply = send(classCore, eventCount, params: [
    (keyDirectObject, NSAppleEventDescriptor.null()),
    (keyClass, NSAppleEventDescriptor(typeCode: typeWindow)),
  ])
  print(reply.paramDescriptor(forKeyword: keyDirectObject)?.int32Value ?? 0)

case "window-id":
  let index = int32Arg(3, "window index")
  let reply = send(classCore, eventGetData, params: [(keyDirectObject, property(propID, of: windowByIndex(index)))])
  print(idAnswer(reply))

case "new-window":
  let created = send(classCore, eventCreate, params: [(keyClass, NSAppleEventDescriptor(typeCode: typeWindow))])
  guard let spec = created.paramDescriptor(forKeyword: keyDirectObject) else { fail("no window came back") }
  let reply = send(classCore, eventGetData, params: [(keyDirectObject, property(propID, of: spec))])
  print(idAnswer(reply))

case "url":
  let id = idArg(3)
  print(answer(send(classCore, eventGetData, params: [(keyDirectObject, property(propURL, of: activeTab(ofWindow: id)))])))

case "set-url":
  let id = idArg(3)
  guard arguments.count > 4 else { fail("url missing") }
  _ = send(classCore, eventSetData, params: [
    (keyDirectObject, property(propURL, of: activeTab(ofWindow: id))),
    (keyData, NSAppleEventDescriptor(string: arguments[4])),
  ])
  print("ok")

case "exec":
  let id = idArg(3)
  let source = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
  print(answer(send(classChrome, eventExecute, params: [
    (keyDirectObject, activeTab(ofWindow: id)),
    (paramJavascript, NSAppleEventDescriptor(string: source)),
  ])))

case "minimize":
  let id = idArg(3)
  _ = send(classCore, eventSetData, params: [
    (keyDirectObject, property(propMinimized, of: windowById(id))),
    (keyData, NSAppleEventDescriptor(boolean: true)),
  ])
  print("ok")

case "bounds":
  let id = idArg(3)
  let x = int32Arg(4, "x"), y = int32Arg(5, "y"), w = int32Arg(6, "width"), h = int32Arg(7, "height")
  let list = NSAppleEventDescriptor.list()
  for value in [x, y, x + w, y + h] { list.insert(NSAppleEventDescriptor(int32: value), at: 0) }
  // insert(at: 0) prepends; rebuild in order.
  let ordered = NSAppleEventDescriptor.list()
  for value in [x, y, x + w, y + h] { ordered.insert(NSAppleEventDescriptor(int32: value), at: ordered.numberOfItems + 1) }
  _ = send(classCore, eventSetData, params: [
    (keyDirectObject, property(propBounds, of: windowById(id))),
    (keyData, ordered),
  ])
  print("ok")

case "get-bounds":
  let id = idArg(3)
  let reply = send(classCore, eventGetData, params: [(keyDirectObject, property(propBounds, of: windowById(id)))])
  guard let result = reply.paramDescriptor(forKeyword: keyDirectObject) else { fail("no bounds came back") }
  // Chrome answers with a QuickDraw rectangle: four 16-bit values, top, left,
  // bottom, right. A list of four numbers is accepted too, as x1 y1 x2 y2.
  var values: [Int32] = []
  if result.descriptorType == fourCC("qdrt") || result.descriptorType == fourCC("QDpt") {
    let data = result.data
    if data.count >= 8 {
      let shorts: [Int16] = data.withUnsafeBytes { raw in (0..<4).map { Int16(littleEndian: raw.load(fromByteOffset: $0 * 2, as: Int16.self)) } }
      values = [Int32(shorts[1]), Int32(shorts[0]), Int32(shorts[3]), Int32(shorts[2])]
    }
  } else if let list = result.coerce(toDescriptorType: fourCC("list")), list.numberOfItems == 4 {
    for index in 1...4 { if let item = list.atIndex(index) { values.append(item.int32Value) } }
  }
  if values.count == 4 {
    print("\(values[0]) \(values[1]) \(values[2] - values[0]) \(values[3] - values[1])")
  } else {
    fail("unexpected bounds (type \(result.descriptorType))")
  }

case "close":
  let id = idArg(3)
  _ = send(classCore, eventClose, params: [(keyDirectObject, windowById(id))])
  print("ok")

case "quit":
  _ = send(classApp, eventQuit, params: [])
  print("ok")

// Not an Apple Event: the workspace hides and shows an application on
// anyone's say-so, no permission asked. A hidden application's windows are
// off screen and out of the Dock's window list, and Chrome — launched with
// occlusion backgrounding off — keeps rendering them all the same.
case "hide", "unhide", "visibility":
  guard let running = NSRunningApplication(processIdentifier: pid) else { fail("Apple Event error -600 no such process") }
  if command != "visibility" {
    let wanted = command == "hide"
    if running.isHidden != wanted {
      _ = wanted ? running.hide() : running.unhide()
      let deadline = Date().addingTimeInterval(2)
      while running.isHidden != wanted && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
      }
    }
    if running.isHidden != wanted { fail("macOS could not \(command) the bot browser") }
  }
  print(running.isHidden ? "hidden" : "visible")

default:
  fail("unknown command \(command)")
}
