package com.next.workhub

import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** RFC 8291 (Web Push message encryption, aes128gcm) — Kotlin port of packages/core/src/webpush.ts. */
object WebPushCrypto {
  class Keys(val publicRaw: ByteArray, val privatePkcs8: ByteArray, val auth: ByteArray)

  class DecryptException(msg: String) : Exception(msg)

  private val p256: ECParameterSpec by lazy {
    AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
  }

  fun generate(): Keys {
    val kpg = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
    val kp = kpg.generateKeyPair()
    val auth = ByteArray(16).also { SecureRandom().nextBytes(it) }
    return Keys(uncompressed(kp.public as ECPublicKey), kp.private.encoded, auth)
  }

  fun uncompressed(pub: ECPublicKey): ByteArray {
    fun fixed(b: BigInteger): ByteArray {
      val raw = b.toByteArray()
      return when {
        raw.size == 32 -> raw
        raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
        else -> ByteArray(32 - raw.size) + raw
      }
    }
    return byteArrayOf(4) + fixed(pub.w.affineX) + fixed(pub.w.affineY)
  }

  private fun publicFromRaw(raw: ByteArray): ECPublicKey {
    if (raw.size != 65 || raw[0] != 4.toByte()) throw DecryptException("bad public key")
    val x = BigInteger(1, raw.copyOfRange(1, 33))
    val y = BigInteger(1, raw.copyOfRange(33, 65))
    return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), p256)) as ECPublicKey
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").run {
      init(SecretKeySpec(key, "HmacSHA256"))
      doFinal(data)
    }

  /** HKDF-SHA256 with a single expand block (length ≤ 32). */
  fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
    val prk = hmac(salt, ikm)
    return hmac(prk, info + byteArrayOf(1)).copyOf(length)
  }

  fun decrypt(body: ByteArray, keys: Keys): String {
    if (body.size < 16 + 4 + 1 + 65 + 17) throw DecryptException("too short")
    val salt = body.copyOfRange(0, 16)
    val rs = ByteBuffer.wrap(body, 16, 4).int.toLong() and 0xffffffffL
    val idlen = body[20].toInt() and 0xff
    if (idlen != 65) throw DecryptException("unexpected keyid length")
    val asPublic = body.copyOfRange(21, 21 + idlen)
    val ciphertext = body.copyOfRange(21 + idlen, body.size)
    if (ciphertext.size > rs) throw DecryptException("multi-record body")

    val priv = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(keys.privatePkcs8))
    val ecdh = KeyAgreement.getInstance("ECDH").run {
      init(priv)
      doPhase(publicFromRaw(asPublic), true)
      generateSecret()
    }
    val keyInfo = "WebPush: info".toByteArray() + byteArrayOf(0) + keys.publicRaw + asPublic
    val ikm = hkdf(keys.auth, ecdh, keyInfo, 32)
    val cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm".toByteArray() + byteArrayOf(0), 16)
    val nonce = hkdf(salt, ikm, "Content-Encoding: nonce".toByteArray() + byteArrayOf(0), 12)
    val plain = try {
      Cipher.getInstance("AES/GCM/NoPadding").run {
        init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
        doFinal(ciphertext)
      }
    } catch (e: Exception) {
      throw DecryptException("authentication failed")
    }
    var end = plain.size - 1
    while (end >= 0 && plain[end] == 0.toByte()) end--
    if (end < 0 || plain[end] != 2.toByte()) throw DecryptException("bad padding")
    return String(plain, 0, end, Charsets.UTF_8)
  }

  fun b64url(bytes: ByteArray): String =
    android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)

  fun b64urlDecode(s: String): ByteArray = android.util.Base64.decode(s, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
}
