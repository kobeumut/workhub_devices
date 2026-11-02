package com.next.workhub

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * App passwords and push private keys, encrypted with a non-exportable AES-256-GCM key in the
 * Android Keystore. Values never leave the device unencrypted at rest; no plain-text fallback.
 */
object SecureStore {
  private const val KEY_ALIAS = "workhub_secrets_v1"
  private const val PREFS = "workhub_secure"

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return gen.generateKey()
  }

  @Synchronized
  fun get(ctx: Context, name: String): String? {
    val v = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(name, null) ?: return null
    val raw = Base64.decode(v, Base64.NO_WRAP)
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
    return String(c.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
  }

  @Synchronized
  fun set(ctx: Context, name: String, value: String) {
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, key())
    val out = c.iv + c.doFinal(value.toByteArray(Charsets.UTF_8))
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(name, Base64.encodeToString(out, Base64.NO_WRAP)).apply()
  }

  @Synchronized
  fun delete(ctx: Context, name: String) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(name).apply()
  }
}
