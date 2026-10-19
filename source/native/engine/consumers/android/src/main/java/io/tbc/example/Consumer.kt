package io.tbc.example
import io.tbc.engine.TbcEngine

class Consumer {
    suspend fun normalize(input: String, expectedArtifactSetId: String): String =
        TbcEngine(expectedArtifactSetId).normalizeRequest(input)
}
