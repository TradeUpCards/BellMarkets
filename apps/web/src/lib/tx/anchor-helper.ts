import type { BN, Idl, Program } from "@coral-xyz/anchor";
import type {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Anchor's `Program<Idl>` types `program.methods` as a broad record where
 * each value may be `undefined`. The discriminator self-consistency check in
 * `scripts/verify-idl.mjs` guarantees the methods we name here exist on the
 * IDL we ship; this helper isolates the unsafe assertion to one place rather
 * than scattering `as any` through the tx builders.
 */
type MethodBuilder = {
  accounts: (
    accounts: Record<string, PublicKey>,
  ) => { instruction: () => Promise<TransactionInstruction> };
};

type MethodsBag = Record<string, ((arg: BN) => MethodBuilder) | undefined>;
type MethodsBagNoArg = Record<string, (() => MethodBuilder) | undefined>;

export async function callAnchorMethod(
  program: Program<Idl>,
  method: string,
  arg: BN,
  accounts: Record<string, PublicKey>,
): Promise<TransactionInstruction> {
  const builders = program.methods as unknown as MethodsBag;
  const builder = builders[method];
  if (!builder) {
    throw new Error(`Anchor method "${method}" missing from IDL.`);
  }
  return builder(arg).accounts(accounts).instruction();
}

export async function callAnchorMethodNoArg(
  program: Program<Idl>,
  method: string,
  accounts: Record<string, PublicKey>,
): Promise<TransactionInstruction> {
  const builders = program.methods as unknown as MethodsBagNoArg;
  const builder = builders[method];
  if (!builder) {
    throw new Error(`Anchor method "${method}" missing from IDL.`);
  }
  return builder().accounts(accounts).instruction();
}
