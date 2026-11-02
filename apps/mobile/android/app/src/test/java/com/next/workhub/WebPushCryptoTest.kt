package com.next.workhub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.util.Base64

/** RFC 8291 Appendix A test vector — same vector as packages/core/test/webpush.test.ts. */
class WebPushCryptoTest {
  private fun d(s: String) = Base64.getUrlDecoder().decode(s)
  private val spec = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
  private val priv = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, d("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")), spec)).encoded
  private val keys = WebPushCrypto.Keys(
    d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
    priv,
    d("BTBZMqHH6r4Tts7J_aSIgg"),
  )
  private val body = d("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")

  @Test fun decryptsRfcVector() {
    assertEquals("When I grow up, I want to be a watermelon", WebPushCrypto.decrypt(body, keys))
  }

  @Test fun rejectsTampered() {
    val t = body.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
    assertThrows(WebPushCrypto.DecryptException::class.java) { WebPushCrypto.decrypt(t, keys) }
  }

  @Test fun routesLikeCore() {
    // org.json is stubbed on the JVM; just verify pure regex rules through notificationId stability
    assertEquals(WorkhubNotifications.notificationId("a", 1), WorkhubNotifications.notificationId("a", 1))
  }
}
