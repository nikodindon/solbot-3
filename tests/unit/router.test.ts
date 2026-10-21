import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  addressLookupTablesFromBuild,
  buildRouterTransaction,
  clampComputeUnitPrice,
  computeUnitLimitFromSimulation,
  decodeComputeUnitPrice,
  ROUTER_CODES,
} from "../../src/execution/router.js";
import type { BuildResponse } from "../../src/jupiter/build.js";

const PAYER = new PublicKey("11111111111111111111111111111111");
// Un programme quelconque : le test ne porte pas sur l'identité du programme.
const PROGRAM = new PublicKey(new Uint8Array(32).fill(7));

/** Instruction `setComputeUnitPrice` : [opcode 3][prix u64 LE]. */
function setUnitPrice(price: bigint): string {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(price, 1);
  return data.toString("base64");
}

function buildResponse(overrides: Partial<BuildResponse> = {}): BuildResponse {
  return {
    computeBudgetInstructions: [
      {
        programId: PROGRAM.toBase58(),
        accounts: [],
        data: setUnitPrice(1_000_000n),
      },
    ],
    setupInstructions: [],
    swapInstruction: {
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      accounts: [{ pubkey: PAYER.toBase58(), isWritable: true, isSigner: true }],
      data: Buffer.from("swap").toString("base64"),
    },
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: null,
    blockhashWithMetadata: {
      blockhash: new Array<number>(32).fill(1),
      lastValidBlockHeight: 1000,
    },
    addressesByLookupTableAddress: {},
    ...overrides,
  };
}

describe("assemblage v0 du chemin Router", () => {
  it("assemble une transaction signable", () => {
    const result = buildRouterTransaction({
      build: buildResponse(),
      payerKey: PAYER,
      cuLimit: 200_000,
    });

    expect(result.cuLimit).toBe(200_000);
    expect(result.lastValidBlockHeight).toBe(1000);
    expect(result.instructionCount).toBeGreaterThan(0);
    // La transaction doit être sérialisable : c'est le vrai test.
    const serialized = result.transaction.serialize();
    expect(serialized.length).toBeGreaterThan(0);
  });

  it("décode le prix des compute units", () => {
    const data = Buffer.from(setUnitPrice(2_500_000n), "base64");
    expect(decodeComputeUnitPrice(data)).toBe(2_500_000);
    // Un opcode inconnu ne donne rien.
    expect(decodeComputeUnitPrice(Buffer.from([9, 1, 2]))).toBeNull();
    expect(decodeComputeUnitPrice(Buffer.from([3]))).toBeNull();
  });

  it("plafonne le prix des compute units", () => {
    const instruction = {
      programId: PROGRAM.toBase58(),
      accounts: [],
      data: setUnitPrice(10_000_000n),
    };
    const clamped = clampComputeUnitPrice(instruction, 1_000_000);
    const price = decodeComputeUnitPrice(Buffer.from(clamped.data, "base64"));
    expect(price).toBe(1_000_000);

    // Une borne plus haute que le plafond ne change rien.
    const untouched = clampComputeUnitPrice(instruction, 100_000_000);
    expect(decodeComputeUnitPrice(Buffer.from(untouched.data, "base64"))).toBe(10_000_000);
  });

  it("dimensionne la limite de CU à partir de la simulation", () => {
    expect(computeUnitLimitFromSimulation(100_000, 1.2)).toBe(120_000);
    // Sans simulation exploitable, on prend le maximum réseau.
    expect(computeUnitLimitFromSimulation(null)).toBe(1_400_000);
    // Jamais au-delà du maximum réseau.
    expect(computeUnitLimitFromSimulation(5_000_000, 1.2)).toBe(1_400_000);
  });

  it("reconstruit les tables d'adresses", () => {
    expect(addressLookupTablesFromBuild(null)).toHaveLength(0);
    // La clé de la table est une adresse valide : le test porte sur la
    // reconstruction, pas sur l'identité de la table.
    const tables = addressLookupTablesFromBuild({
      [PAYER.toBase58()]: [PAYER.toBase58()],
    });
    expect(tables).toHaveLength(1);
    expect(tables[0]?.state?.addresses).toHaveLength(1);
  });

  it("refuse un build sans instruction de swap", () => {
    expect(() =>
      buildRouterTransaction({
        build: buildResponse({ swapInstruction: { error: "aucune route" } }),
        payerKey: PAYER,
        cuLimit: 200_000,
      }),
    ).toThrow(/erreur/);
  });

  it("refuse un build sans blockhash", () => {
    expect(() =>
      buildRouterTransaction({
        build: buildResponse({ blockhashWithMetadata: undefined }),
        payerKey: PAYER,
        cuLimit: 200_000,
      }),
    ).toThrow(/blockhash/);
  });

  it("utilise des codes distincts de ceux de Jupiter", () => {
    // Un code Router ne doit jamais être confondu avec un code `/execute`.
    for (const code of Object.values(ROUTER_CODES)) {
      expect(code).toBeLessThan(-9000);
    }
  });
});
