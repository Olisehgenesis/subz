import {
  EncryptedVetKey,
  TransportSecretKey,
  DerivedPublicKey,
  type VetKey,
} from "@dfinity/vetkeys";
import {
  approveVetKeyDerivation,
  deriveVetKey,
  listVetKeys,
  requestVetKeys,
} from "neutron-tools/app";

export const KEYS_SLOT = "keys";

const ENCRYPTED_VETKEY_BYTES = 192;
const CONTEXT_PUBLIC_KEY_BYTES = 96;
const DERIVATION_INPUT_BYTES = 32;

// Domain separator for the AES-256-GCM key derived from the vetKey.
const KEY_DOMAIN = "subz-keys-v1";

function fixedBytes(
  value: ArrayLike<number>,
  length: number,
  label: string,
): Uint8Array {
  const bytes = Array.from(value);
  if (bytes.length !== length || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error(`Invalid ${label}`);
  }
  return Uint8Array.from(bytes);
}

type SlotSummary = {
  slot: string;
  status: "enabled" | "disabled" | "manifest_suspended";
  currentGeneration: string;
  previousGeneration: string | null;
};

async function keysSlotSummary(): Promise<SlotSummary | null> {
  const result = await listVetKeys();
  return (result.slots.find((s) => s.slot === KEYS_SLOT) ?? null) as SlotSummary | null;
}

/**
 * Reserves and enables the keys slot. Both lifecycle steps pass through a
 * kernel-owned consent dialog and must start in the focused tile.
 */
export async function ensureKeysSlot(): Promise<SlotSummary> {
  let summary = await keysSlotSummary();
  if (!summary) {
    await requestVetKeys({ action: "reserve", slot: KEYS_SLOT });
    summary = await keysSlotSummary();
  }
  if (summary && summary.status !== "enabled") {
    await requestVetKeys({ action: "enable", slot: KEYS_SLOT });
    summary = await keysSlotSummary();
  }
  if (!summary || summary.status !== "enabled") {
    throw new Error("Keys slot is not enabled");
  }
  return summary;
}

/**
 * Runs the source-bound derivation handshake and returns the verified VetKey.
 * The transport secret never leaves this function; the caller receives an
 * opaque key handle.
 */
export async function deriveVaultKey(): Promise<VetKey> {
  const summary = await ensureKeysSlot();

  const transport = TransportSecretKey.random();
  const requestNonce = new Uint8Array(32);
  crypto.getRandomValues(requestNonce);

  const result = await deriveVetKey(
    {
      slot: KEYS_SLOT,
      generation: summary.currentGeneration,
      transportPublicKey: transport.publicKeyBytes(),
      requestNonce,
    },
    {
      onChallenge(challenge) {
        // Protocol confirmation, not a user decision: approve immediately.
        void approveVetKeyDerivation({ challengeId: challenge.challengeId });
      },
    },
  );

  const encryptedVetKey = fixedBytes(
    result.encryptedKey,
    ENCRYPTED_VETKEY_BYTES,
    "encrypted vetKey",
  );
  const publicInfo = result.publicInfo;
  const contextPublicKey = fixedBytes(
    publicInfo.publicKey,
    CONTEXT_PUBLIC_KEY_BYTES,
    "context public key",
  );
  const derivationInput = fixedBytes(
    publicInfo.derivationInput,
    DERIVATION_INPUT_BYTES,
    "derivation input",
  );

  return EncryptedVetKey.deserialize(encryptedVetKey).decryptAndVerify(
    transport,
    DerivedPublicKey.deserialize(contextPublicKey),
    derivationInput,
  );
}

async function vaultAesKey(vetKey: VetKey): Promise<CryptoKey> {
  const keyBytes = vetKey.deriveSymmetricKey(KEY_DOMAIN, 32);
  return crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypts UTF-8 text; output layout is nonce (12 B) || AES-GCM ciphertext. */
export async function sealSecret(vetKey: VetKey, plaintext: string): Promise<Uint8Array> {
  const key = await vaultAesKey(vetKey);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  const out = new Uint8Array(nonce.length + body.length);
  out.set(nonce, 0);
  out.set(body, nonce.length);
  return out;
}

/** Decrypts output produced by sealSecret. Throws on tampering. */
export async function unsealSecret(vetKey: VetKey, sealed: Uint8Array): Promise<string> {
  if (sealed.length < 13) throw new Error("Ciphertext too short");
  const key = await vaultAesKey(vetKey);
  const nonce = sealed.slice(0, 12);
  const body = sealed.slice(12);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    key,
    body as BufferSource,
  );
  return new TextDecoder().decode(plain);
}
