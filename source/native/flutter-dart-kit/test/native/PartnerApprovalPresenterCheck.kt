package io.tbc.kit.dart
import example.tbc.PartnerApprovalPresenter
fun main() {
 val r=NativeReview("op","https://wallet.example","tbc:testnet","fixture","Batch","All terms")
 var decision:((Boolean)->Unit)?=null
 var shown=0;var closed=0;var updated=0;val answers=mutableListOf<Boolean>()
 val ui=PartnerApprovalPresenter(show={_,reply->shown++;decision=reply;{closed++;Unit}},
  refresh={review->check(review.description=="All terms");updated++})
 val dismiss=ui.present(r){answers+=it}
 val bound=r.copy(phase="binding-verified")
 ui.update(bound);check(updated==0)
 decision?.invoke(true);decision?.invoke(false);dismiss();dismiss();ui.update(bound)
 ui.update(bound.copy(origin="https://wrong.example"))
 check(shown==1&&closed==1&&updated==1&&answers==listOf(true))
 ui.finish("op");ui.update(bound);check(updated==1)
 val reject=ui.present(r){answers+=it};decision?.invoke(false);reject();ui.update(bound)
 check(answers==listOf(true,false)&&updated==1&&closed==2)
 lateinit var sync:PartnerApprovalPresenter
 sync=PartnerApprovalPresenter(show={_,reply->reply(false);{closed++;Unit}},refresh={error("Unexpected update")})
 val syncDismiss=sync.present(r){sync.finish("op")};syncDismiss();check(closed==3)
 println("PARTNER_APPROVAL_ADAPTER_PASS one-decision, bound-update, reject, stale, synchronous-close")
}
