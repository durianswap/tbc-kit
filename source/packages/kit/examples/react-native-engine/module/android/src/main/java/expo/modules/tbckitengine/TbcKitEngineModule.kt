package expo.modules.tbckitengine

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.ModuleDefinition
import io.tbc.engine.TbcEngine
import io.tbc.engine.TbcEngineMethod
import io.tbc.engine.TbcKeylessEngine
import io.tbc.engine.TbcKeylessOperation

class TbcKitEngineModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TbcKitEngine")
    Constant("artifactSetId") { TbcEngine.artifactSetId }
    AsyncFunction("call") Coroutine { method: String, input: String ->
      val selected = TbcEngineMethod.entries.singleOrNull { it.wireName == method }
        ?: throw IllegalArgumentException("Unsupported Engine method")
      TbcEngine().callEnvelope(selected, input)
    }
    AsyncFunction("callKeyless") Coroutine { operation: String, input: String ->
      val selected = TbcKeylessOperation.entries.singleOrNull { it.wireName == operation }
        ?: throw IllegalArgumentException("Unsupported Keyless operation")
      TbcKeylessEngine().callEnvelope(selected, input)
    }
  }
}
