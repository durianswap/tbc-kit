package io.tbc.signerexample

import org.junit.Test
import runMuSigProbe

class MuSigProbeTest {
    @Test fun actualAarAndJni() {
        println("MUSIG_KOTLIN_JNI_REPORT " + runMuSigProbe())
    }
}
