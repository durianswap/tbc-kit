
// Test-only Activity, appended to the existing public native replay harness.
private fun executeDisplayBatch(h:Harness,row:Map<String,Any?>):Map<String,Double>{
 val start=System.nanoTime();h.ui.choose("op");val receipt=h.bind();val bound=System.nanoTime();val plan=map(h.sample["plan"]);val payload=map(plan["payload"])
 for(source in (row["steps"] as List<*>).map{map(it)}){
  val id=source["id"] as String;val resolved=(row["deferred"] as List<*>).map{map(it)}.firstOrNull{it["stepId"]==id}?.let{map(it["resolved"])}
  val tasks=resolved?.let{listOf(map(it["concreteTask"]))}?:(payload["immediateSigningTasks"] as List<*>).map{map(it)}.filter{it["stepId"]==id}.map{map(it["task"])}
  h.enter(receipt,mapOf("kind" to "workflow-step","stepId" to id,"workflowPlanHash" to plan["workflowPlanHash"],"tasks" to tasks)+(if(resolved!=null)mapOf("resolvedDeferredSigningTask" to resolved)else emptyMap()));for(task in tasks)h.sign(receipt,task)
  val result=map(source["result"]).toMutableMap();if(result.containsKey("approvalId"))result["approvalId"]=receipt["approvalId"]
  h.finish(receipt,mapOf("kind" to "workflow-step-outcome","stepId" to id,"workflowPlanHash" to plan["workflowPlanHash"],"status" to "completed","result" to result))
 }
 h.c.close("v",h.scope,"op");check(h.ui.shown==2&&h.key.signs==(row["signed"] as List<*>).size)
 return mapOf("approvalToBoundMs" to (bound-start)/1e6,"approvalToReplayCompleteMs" to (System.nanoTime()-start)/1e6)
}
class DisplayActivity:android.app.Activity(){
 private lateinit var details:android.widget.TextView;private lateinit var status:android.widget.TextView
 private var harness:Harness?=null;private var row=emptyMap<String,Any?>();private val report=mutableMapOf<String,Any?>()
 private val fixture get()=File(filesDir,"workflow.json")
 override fun onCreate(state:android.os.Bundle?){
  super.onCreate(state);val stack=android.widget.LinearLayout(this);stack.orientation=1;stack.setPadding(16,16,16,16)
  status=android.widget.TextView(this);status.textSize=16f;stack.addView(status)
  details=android.widget.TextView(this);details.textSize=12f;details.setTextIsSelectable(true)
  val scroll=android.widget.ScrollView(this);scroll.addView(details);stack.addView(scroll,android.widget.LinearLayout.LayoutParams(-1,0,1f))
  fun button(label:String,action:()->Unit){val b=android.widget.Button(this);b.text=label;b.contentDescription=label;b.setOnClickListener{guarded(action)};stack.addView(b)}
  button("Prepare batch"){harness?.let{runCatching{it.c.cancel("v",it.scope,"op")}};load();start()}
  button("Approve once"){val h=harness!!;if(h.ui.pending.containsKey("op")){val times=executeDisplayBatch(h,row);report["approved"]=mapOf("operationApprovals" to h.ui.shown-1,"replayedSignatures" to h.key.signs,"timings" to times);status.text="APPROVED · one batch · replay completed";save()}}
  button("Reject"){val h=harness!!;if(h.ui.pending.containsKey("op")){h.ui.choose("op",false);check(!h.answer!!.getOrThrow());check(runCatching{h.bind()}.isFailure&&h.key.signs==0);report["rejected"]=mapOf("signatures" to h.key.signs,"operationApprovals" to h.ui.shown-1);status.text="REJECTED · zero signatures";save()}}
  button("Benchmark"){
   load();val times=mutableListOf<Map<String,Double>>()
   repeat(21){index->val h=newHarness();val start=System.nanoTime();h.consent();val t=executeDisplayBatch(h,row).toMutableMap();t["consentProjectionMs"]=(System.nanoTime()-start)/1e6-t.getValue("approvalToReplayCompleteMs");if(index>0)times+=t}
   report["benchmark"]=times;status.text="BENCHMARK COMPLETE · 20 warm repetitions";save()
  }
  setContentView(stack);guarded{workflowDisplayChecks(arrayOf(fixture.path));report["directedTests"]="PASS";load();start();save()}
 }
 private fun load(){row=(PermissionJson.records("[${fixture.readText()}]").single()["stepCases"] as List<*>).map{map(it)}.single{map(it["sample"])["name"]=="native-message"}}
 private fun newHarness():Harness{val h=Harness(map(row["sample"]));h.key.recorded=(row["signed"] as List<*>).map{map(it)};h.grant();h.begin();return h}
 private fun start(){val h=newHarness();harness=h
  // CANDIDATE: Update the same details view; no second decision.
  h.ui.onUpdate={details.text=it.description}
  h.consent();details.text=h.ui.reviews.getValue("op").description;status.text="READY · public fixture · no network"
 }
 private fun guarded(action:()->Unit){try{action()}catch(e:Throwable){status.text="FAIL: ${e.javaClass.simpleName}: ${e.message}";report["error"]=status.text.toString();save()}}
 private fun save(){report["platform"]="android-emulator";report["chainReads"]=0;report["broadcasts"]=0;report["realCryptographicSigning"]=false;File(filesDir,"report.json").writeText(org.json.JSONObject(report).toString(2))}
}
