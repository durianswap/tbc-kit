import Foundation
@main @MainActor struct PartnerApprovalPresenterCheck {
 static func main() {
  let r=NativeReview(operationId:"op",origin:"https://wallet.example",chainId:"tbc:testnet",accountAddress:"fixture",title:"Batch",description:"All terms")
  var decision: (@MainActor (Bool)->Void)?
  var shown=0,closed=0,updated=0,answers=[Bool]()
  let ui=PartnerApprovalPresenter(show:{ review,reply in shown+=1;decision=reply;return{closed+=1}},
   refresh:{ review in precondition(review.description=="All terms");updated+=1})
  let dismiss=ui.present(r){answers.append($0)}
  var bound=r;bound.phase="binding-verified"
  ui.update(bound);precondition(updated==0)
  decision?(true);decision?(false);dismiss();dismiss()
  ui.update(bound)
  var wrong=NativeReview(operationId:"op",origin:"https://wrong.example",chainId:r.chainId,accountAddress:r.accountAddress,title:r.title,description:r.description)
  wrong.phase="binding-verified";ui.update(wrong)
  precondition(shown==1 && closed==1 && updated==1 && answers==[true])
  ui.finish(operationId:"op");ui.update(bound);precondition(updated==1)
  let reject=ui.present(r){answers.append($0)}
  decision?(false);reject();ui.update(bound);precondition(answers==[true,false] && updated==1 && closed==2)
  var sync:PartnerApprovalPresenter!
  sync=PartnerApprovalPresenter(show:{ _,reply in reply(false);return{closed+=1}},refresh:{_ in preconditionFailure()})
  let syncDismiss=sync.present(r){_ in sync.finish(operationId:"op")}
  syncDismiss();precondition(closed==3)
  print("PARTNER_APPROVAL_ADAPTER_PASS one-decision, bound-update, reject, stale, synchronous-close")
 }
}
