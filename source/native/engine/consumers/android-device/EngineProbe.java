package io.tbc.validation;

import android.os.Build;
import io.tbc.engine.TbcEngine;
import io.tbc.engine.TbcEngineMethod;
import io.tbc.engine.TbcEngineFailure;
import kotlin.ResultKt;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlin.coroutines.intrinsics.IntrinsicsKt;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.concurrent.*;

/** Shell-process probe: real Android ART and packaged AAR/JNI, no app, key or HTTP client. */
public final class EngineProbe {
    interface Invocation { Object invoke(Continuation<? super String> completion); }

    private static String await(Invocation operation) throws Exception {
        final CountDownLatch done = new CountDownLatch(1);
        final String[] value = new String[1];
        final Throwable[] failure = new Throwable[1];
        Object immediate = operation.invoke(new Continuation<String>() {
            public CoroutineContext getContext() { return EmptyCoroutineContext.INSTANCE; }
            public void resumeWith(Object result) {
                try { ResultKt.throwOnFailure(result); value[0] = (String) result; }
                catch (Throwable error) { failure[0] = error; }
                finally { done.countDown(); }
            }
        });
        if (immediate != IntrinsicsKt.getCOROUTINE_SUSPENDED()) return (String) immediate;
        if (!done.await(20, TimeUnit.SECONDS)) throw new AssertionError("Engine timeout");
        if (failure[0] instanceof Exception) throw (Exception) failure[0];
        if (failure[0] != null) throw new AssertionError(failure[0]);
        return value[0];
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        require(args.length == 2, "Expected vector path and pinned artifact identity");
        require(TbcEngine.artifactSetId.equals(args[1]), "Packaged identity mismatch");
        try { new TbcEngine("wrong"); throw new AssertionError("Identity mismatch accepted"); }
        catch (IllegalArgumentException expected) { }
        final TbcEngine engine = new TbcEngine(args[1]);
        final JSONArray cases = new JSONArray(new String(Files.readAllBytes(Paths.get(args[0])), java.nio.charset.StandardCharsets.UTF_8));
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            final String input = c.getString("input");
            TbcEngineMethod method = null;
            for (TbcEngineMethod candidate : TbcEngineMethod.values()) {
                if (candidate.getWireName().equals(c.getString("method"))) method = candidate;
            }
            require(method != null, "Unsupported vector method");
            final TbcEngineMethod selected = method;
            require(c.getString("expected").equals(await(k -> engine.callEnvelope(selected, input, k))), "Native/WASM envelope mismatch");
        }
        JSONObject first = cases.getJSONObject(0);
        final String input = first.getString("input"), expected = first.getString("expected");
        ExecutorService workers = Executors.newFixedThreadPool(4);
        try {
            ArrayList<Future<?>> pending = new ArrayList<>();
            for (int i = 0; i < 16; i++) pending.add(workers.submit(() -> {
                require(expected.equals(await(k -> engine.normalizeRequest(input, k))), "Concurrent output mismatch");
                return null;
            }));
            for (Future<?> task : pending) task.get(30, TimeUnit.SECONDS);
        } finally { workers.shutdownNow(); }
        Invocation[] rejected = {
            k -> engine.normalizeRequest("中文🍈", k), k -> engine.plan("{}", k),
            k -> engine.validate("{}", k), k -> engine.finalize("{}", k)
        };
        for (Invocation operation : rejected) {
            try { await(operation); throw new AssertionError("Engine failure not mapped"); }
            catch (TbcEngineFailure error) { require(!error.getCode().isEmpty(), "Missing Engine error code"); }
        }
        System.out.println("ANDROID_NATIVE_PROBE_PASS runtime=ART api=" + Build.VERSION.SDK_INT
            + " abi=" + Build.SUPPORTED_ABIS[0] + " cases=" + cases.length() + " concurrent=16");
    }
}
