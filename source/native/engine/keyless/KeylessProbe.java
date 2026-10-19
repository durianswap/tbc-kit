package io.tbc.validation;
import io.tbc.engine.*;
import kotlin.ResultKt;
import kotlin.coroutines.*;
import kotlin.coroutines.intrinsics.IntrinsicsKt;
import org.json.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
public final class KeylessProbe {
    interface Invocation { Object invoke(Continuation<? super String> done); }
    static String await(Invocation op) throws Exception {
        CountDownLatch latch=new CountDownLatch(1);String[] value=new String[1];Throwable[] error=new Throwable[1];
        Object immediate=op.invoke(new Continuation<String>() {
            public CoroutineContext getContext(){return EmptyCoroutineContext.INSTANCE;}
            public void resumeWith(Object r){try{ResultKt.throwOnFailure(r);value[0]=(String)r;}catch(Throwable e){error[0]=e;}finally{latch.countDown();}}
        });
        if(immediate!=IntrinsicsKt.getCOROUTINE_SUSPENDED())return (String)immediate;
        if(!latch.await(30,TimeUnit.SECONDS))throw new AssertionError("Timeout");
        if(error[0]!=null)throw new AssertionError(error[0]);return value[0];
    }
    static TbcKeylessOperation method(String name){for(TbcKeylessOperation m:TbcKeylessOperation.values())if(m.getWireName().equals(name))return m;throw new IllegalArgumentException(name);}
    static void check(TbcKeylessEngine engine,JSONObject c)throws Exception{
        TbcKeylessOperation selected=method(c.getString("method"));String input=c.getString("input");
        String raw=await(k->engine.callEnvelope(selected,input,k));
        if(!raw.equals(c.getString("expected")))throw new AssertionError("Native/WASM mismatch: "+c.getString("method"));
    }
    public static void main(String[] args)throws Exception{
        if(!TbcEngine.artifactSetId.equals(args[1]))throw new AssertionError("Identity mismatch");
        try{new TbcKeylessEngine("wrong");throw new AssertionError("Wrong identity accepted");}catch(IllegalArgumentException expected){}
        TbcKeylessEngine engine=new TbcKeylessEngine(args[1]);JSONArray cases=new JSONArray(new String(Files.readAllBytes(Paths.get(args[0])),java.nio.charset.StandardCharsets.UTF_8));
        for(int i=0;i<cases.length();i++)check(engine,cases.getJSONObject(i));
        ExecutorService workers=Executors.newFixedThreadPool(4);
        try{List<Future<?>> pending=new ArrayList<>();for(int i=0;i<16;i++)pending.add(workers.submit(()->{check(engine,cases.getJSONObject(0));return null;}));for(Future<?> f:pending)f.get(30,TimeUnit.SECONDS);}finally{workers.shutdownNow();}
        try{method("sign");throw new AssertionError("Signing exposed");}catch(IllegalArgumentException expected){}
        System.out.println("KEYLESS_ANDROID_PASS cases="+cases.length()+" concurrent=16");
    }
}
