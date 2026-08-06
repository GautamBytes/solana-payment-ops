import type { ResolvedAccountKey } from "../domain/types.js";
import type { PaymentFixture } from "../fixtures/schema.js";

type Message = PaymentFixture["rpcTransaction"]["transaction"]["message"];
type LoadedAddresses =
  PaymentFixture["rpcTransaction"]["meta"]["loadedAddresses"];

export function resolveAccountKeys(
  message: Message,
  loadedAddresses: LoadedAddresses,
): readonly ResolvedAccountKey[] {
  const {
    numRequiredSignatures,
    numReadonlySignedAccounts,
    numReadonlyUnsignedAccounts,
  } = message.header;
  const writableSignerCount = numRequiredSignatures - numReadonlySignedAccounts;
  const writableUnsignedEnd =
    message.accountKeys.length - numReadonlyUnsignedAccounts;

  const staticKeys = message.accountKeys.map((accountAddress, index) => {
    const signer = index < numRequiredSignatures;
    const writable = signer
      ? index < writableSignerCount
      : index < writableUnsignedEnd;

    return {
      address: accountAddress,
      signer,
      writable,
      source: "static" as const,
    };
  });

  const writableLoaded = (loadedAddresses?.writable ?? []).map(
    (accountAddress) => ({
      address: accountAddress,
      signer: false,
      writable: true,
      source: "loaded-writable" as const,
    }),
  );
  const readonlyLoaded = (loadedAddresses?.readonly ?? []).map(
    (accountAddress) => ({
      address: accountAddress,
      signer: false,
      writable: false,
      source: "loaded-readonly" as const,
    }),
  );

  return [...staticKeys, ...writableLoaded, ...readonlyLoaded];
}
