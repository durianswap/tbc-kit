-keep class io.tbc.signer.TbcDigestSigner { *; }
# Preserve optional JNI lookup names without forcing unused MuSig into consumers.
-keep,allowoptimization,allowshrinking class io.tbc.signer.MuSigNative { native <methods>; }
