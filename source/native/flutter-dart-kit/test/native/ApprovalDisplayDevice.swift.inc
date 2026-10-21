
import UIKit
// Appended to the test-only native harness by the builder. No private keys,
// network entitlement, Engine rebuild or live broadcast. Signatures are replay.
@MainActor private func executeDisplayBatch(_ h:Harness,_ row:[String:Any])throws->[String:Double]{
 let start=ProcessInfo.processInfo.systemUptime;h.ui.choose("op");let receipt=try h.bind()
 let bound=ProcessInfo.processInfo.systemUptime,plan=map(h.sample["plan"]),payload=map(plan["payload"])
 for source in row["steps"] as! [[String:Any]]{
  let id=source["id"] as! String
  let resolved=(row["deferred"] as! [[String:Any]]).first{$0["stepId"] as? String==id}.map{map($0["resolved"])}
  let tasks=resolved.map{[map($0["concreteTask"])]} ?? (payload["immediateSigningTasks"] as! [[String:Any]]).filter{$0["stepId"] as? String==id}.map{map($0["task"])}
  var entry:[String:Any]=["kind":"workflow-step","stepId":id,"workflowPlanHash":plan["workflowPlanHash"]!,"tasks":tasks]
  if let resolved{entry["resolvedDeferredSigningTask"]=resolved}
  try h.enter(receipt,entry)
  for task in tasks{_ = try h.sign(receipt,task)}
  var result=try copy(map(source["result"]));if result["approvalId"] != nil{result["approvalId"]=receipt["approvalId"]}
  try h.finish(receipt,["kind":"workflow-step-outcome","stepId":id,"workflowPlanHash":plan["workflowPlanHash"]!,"status":"completed","result":result])
 }
 try h.c.close(owner:"v",scope:h.scope,id:"op")
 precondition(h.ui.shown==2 && h.key.signs==(row["signed"] as! [Any]).count)
 return ["approvalToBoundMs":(bound-start)*1000,"approvalToReplayCompleteMs":(ProcessInfo.processInfo.systemUptime-start)*1000]
}
@MainActor private final class DisplayController:UIViewController{
 let details=UITextView(),status=UILabel();var harness:Harness?,row=[String:Any](),report=[String:Any]()
 let fixture=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("workflow.json")
 override func viewDidLoad(){
  super.viewDidLoad();view.backgroundColor = .systemBackground;details.isEditable=false;details.font = .monospacedSystemFont(ofSize:12,weight:.regular);details.accessibilityIdentifier="approval-details";status.numberOfLines=0;status.accessibilityIdentifier="test-status"
  let stack=UIStackView();stack.axis = .vertical;stack.spacing=8;stack.translatesAutoresizingMaskIntoConstraints=false;view.addSubview(stack)
  stack.addArrangedSubview(status);stack.addArrangedSubview(details)
  for (title,action) in [("Prepare batch",#selector(prepareBatch)),("Approve once",#selector(approve)),("Reject",#selector(reject)),("Benchmark",#selector(benchmark))]{let b=UIButton(type:.system);b.setTitle(title,for:.normal);b.accessibilityIdentifier=title;b.addTarget(self,action:action,for:.touchUpInside);stack.addArrangedSubview(b)}
  NSLayoutConstraint.activate([stack.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor),stack.bottomAnchor.constraint(equalTo:view.safeAreaLayoutGuide.bottomAnchor),stack.leadingAnchor.constraint(equalTo:view.leadingAnchor,constant:12),stack.trailingAnchor.constraint(equalTo:view.trailingAnchor,constant:-12)])
  do{try WorkflowConsentCheck.run(fixture.path);report["directedTests"]="PASS";try load();try start();save()}catch{fail(error)}
 }
 func load()throws{let root=map(try JSONSerialization.jsonObject(with:Data(contentsOf:fixture)));row=(root["stepCases"] as! [[String:Any]]).first{map($0["sample"])["name"] as? String=="native-message"}!}
 func newHarness()throws->Harness{let h=try Harness(map(row["sample"]));h.key.recorded=row["signed"] as! [[String:Any]];try h.grant();try h.begin();return h}
 func start()throws{
  let h=try newHarness();harness=h
  // CANDIDATE: Informational update, never presents another approval.
  h.ui.onUpdate={[weak self] r in self?.details.text=r.description}
  try h.consent();details.text=h.ui.reviews["op"]!.description;status.text="READY · public fixture · no network"
 }
 @objc func prepareBatch(){do{if let h=harness{try? h.c.cancel(owner:"v",scope:h.scope,id:"op")};try load();try start()}catch{fail(error)}}
 @objc func approve(){do{guard let h=harness,h.ui.pending["op"] != nil else{return};let times=try executeDisplayBatch(h,row);report["approved"]=["operationApprovals":h.ui.shown-1,"replayedSignatures":h.key.signs,"timings":times];status.text="APPROVED · one batch · replay completed";save()}catch{fail(error)}}
 @objc func reject(){do{guard let h=harness,h.ui.pending["op"] != nil else{return};h.ui.choose("op",false);let denied=try !h.answer!.get();precondition(denied);var refused=false;do{_ = try h.bind()}catch{refused=true};precondition(refused && h.key.signs==0);report["rejected"]=["signatures":h.key.signs,"operationApprovals":h.ui.shown-1];status.text="REJECTED · zero signatures";save()}catch{fail(error)}}
 @objc func benchmark(){do{
  try load();var times=[[String:Double]]()
  for index in 0..<21{let h=try newHarness();let start=ProcessInfo.processInfo.systemUptime;try h.consent();var t=try executeDisplayBatch(h,row);t["consentProjectionMs"]=(ProcessInfo.processInfo.systemUptime-start)*1000-t["approvalToReplayCompleteMs"]!;if index>0{times.append(t)}}
  report["benchmark"]=times;status.text="BENCHMARK COMPLETE · 20 warm repetitions";save()
 }catch{fail(error)}}
 func fail(_ e:Error){status.text="FAIL: \(e)";report["error"]=String(describing:e);save()}
 func save(){report["platform"]="ios-simulator";report["chainReads"]=0;report["broadcasts"]=0;report["realCryptographicSigning"]=false;try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:fixture.deletingLastPathComponent().appendingPathComponent("report.json"))}
}
@main @MainActor private final class DisplayApp:UIResponder,UIApplicationDelegate{
 var window:UIWindow?
 func application(_ application:UIApplication,didFinishLaunchingWithOptions options:[UIApplication.LaunchOptionsKey:Any]?)->Bool{let w=UIWindow(frame:UIScreen.main.bounds);w.rootViewController=DisplayController();w.makeKeyAndVisible();window=w;return true}
}
