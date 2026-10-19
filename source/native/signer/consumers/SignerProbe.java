package io.tbc.validation;
import io.tbc.signer.TbcDigestSigner;
import io.tbc.signer.TbcSignatureEncoding;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;
import org.json.JSONObject;

public final class SignerProbe {
  private static byte[] hex(String s) {
    byte[] bytes = new byte[s.length() / 2];
    for (int i = 0; i < bytes.length; i++) bytes[i] = (byte)Integer.parseInt(s.substring(i*2, i*2+2), 16);
    return bytes;
  }
  public static void main(String[] args) throws Exception {
    var vectors = new JSONObject(new String(Files.readAllBytes(Paths.get(args[0])), java.nio.charset.StandardCharsets.UTF_8)).getJSONArray("vectors");
    int count = 0;
    for (int i = 0; i < vectors.length(); i++) {
      var v = vectors.getJSONObject(i); byte[] key = hex(v.getString("scalar"));
      try {
        for (var encoding : new TbcSignatureEncoding[]{TbcSignatureEncoding.COMPACT64, TbcSignatureEncoding.COMPACT65_RECOVERABLE}) {
          byte[] actual = TbcDigestSigner.INSTANCE.sign(hex(v.getString("digest")), key, encoding);
          if (!Arrays.equals(actual, hex(v.getString("compact" + encoding.getSize())))) throw new AssertionError("Signature mismatch");
          if (!Arrays.equals(key, hex(v.getString("scalar")))) throw new AssertionError("Caller buffer changed");
          count++;
        }
      } finally { Arrays.fill(key, (byte)0); }
    }
    byte[] invalidHigh = new byte[32]; Arrays.fill(invalidHigh, (byte)255);
    byte[][][] invalid = { {new byte[31], new byte[32]}, {new byte[32], new byte[31]}, {new byte[32], new byte[32]}, {new byte[32], invalidHigh} };
    for (var pair : invalid) {
      try { TbcDigestSigner.INSTANCE.sign(pair[0], pair[1], TbcSignatureEncoding.COMPACT64); throw new AssertionError("Invalid input accepted"); }
      catch (IllegalArgumentException expected) { count++; }
    }
    if (count != 52) throw new AssertionError("Wrong count");
    System.out.println("SIGNER_ANDROID_ART_PASS checks=52");
    byte[] schnorrKey=new byte[32];schnorrKey[31]=3;
    byte[] schnorr=TbcDigestSigner.INSTANCE.sign(new byte[32],schnorrKey,TbcSignatureEncoding.SCHNORR64);
    if(!Arrays.equals(schnorr,hex("e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0")))throw new AssertionError("Schnorr mismatch");
    if(Arrays.equals(schnorr,TbcDigestSigner.INSTANCE.sign(new byte[32],schnorrKey,TbcSignatureEncoding.COMPACT64)))throw new AssertionError("Algorithms mixed");
    Arrays.fill(schnorrKey,(byte)0);
    try{TbcDigestSigner.INSTANCE.sign(new byte[32],schnorrKey,TbcSignatureEncoding.SCHNORR64);throw new AssertionError("Invalid Schnorr key accepted");}catch(IllegalArgumentException expectedFailure){}
    System.out.println("SCHNORR_ANDROID_ART_PASS checks=3");
    byte[] key=new byte[32];Arrays.fill(key,(byte)7);
    byte[] message="Native crypto 独立向量".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    byte[] expected=hex("4249453102989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6ff99741713c05883f92ecb23261254e069265bf15c77057e79861b91604f018961006b71b93bb9fc4fa2ffdbb645b2ebf36c024b79b9fedb31d87d9e822598c33");
    byte[] encrypted=TbcDigestSigner.INSTANCE.crypt(message,key,false);
    if(!Arrays.equals(expected,encrypted)||!Arrays.equals(message,TbcDigestSigner.INSTANCE.crypt(encrypted,key,true)))throw new AssertionError("Crypto mismatch");
    encrypted[encrypted.length-1]^=1;
    try{TbcDigestSigner.INSTANCE.crypt(encrypted,key,true);throw new AssertionError("Corruption accepted");}catch(IllegalArgumentException expectedFailure){}
    if(TbcDigestSigner.INSTANCE.crypt(TbcDigestSigner.INSTANCE.crypt(new byte[0],key,false),key,true).length!=0)throw new AssertionError("Empty message mismatch");
    Arrays.fill(key,(byte)0);System.out.println("CRYPTO_ANDROID_PASS checks=4");
  }
}
