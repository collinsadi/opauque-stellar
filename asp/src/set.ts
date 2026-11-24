/**
 * The association set: approved deposit labels, ordered by approval (== tree leaf order),
 * hashed into a depth-20 Poseidon(2) tree whose root the withdraw circuit proves against.
 * Under `approveAll`, leaf index == deposit index, so a withdrawer's ASP path index is
 * simply their deposit index; selective policies compact the set and clients look the
 * label's position up in the published manifest.
 */
import { computeLabel, MerkleTree, getPoseidon, toHex32 } from "./merkle.ts";
import { computeDatasetHash, type UnsignedSetManifest } from "./publish.ts";

export class AssociationSet {
  readonly indices: number[] = [];
  readonly labels: bigint[] = [];
  private tree: MerkleTree;

  private constructor(private poseidon: any, readonly scope: number) {
    this.tree = new MerkleTree(poseidon);
  }

  static async create(scope: number): Promise<AssociationSet> {
    return new AssociationSet(await getPoseidon(), scope);
  }

  /** Append an approved deposit's label to the set. */
  add(depositIndex: number): void {
    const label = computeLabel(this.poseidon, this.scope, depositIndex);
    this.indices.push(depositIndex);
    this.labels.push(label);
    this.tree.insert(label);
  }

  get size(): number {
    return this.labels.length;
  }

  rootHex(): string {
    return toHex32(this.tree.root());
  }

  /** Inclusion proof for the label at the given tree-leaf position. */
  proof(leafIndex: number) {
    return this.tree.proof(leafIndex);
  }

  /** The unsigned manifest for this set; `writeManifest` signs it. */
  manifest(
    poolId: string,
    generatedAt: string,
    meta: { policy: string; ledger: number },
  ): UnsignedSetManifest {
    const root = this.rootHex();
    const labels = this.labels.map((l) => l.toString());
    return {
      poolId,
      root,
      version: this.labels.length,
      levels: this.tree.depth,
      algo: "poseidon-bn254",
      labels,
      indices: [...this.indices],
      generatedAt,
      datasetHash: computeDatasetHash(root, labels),
      policy: meta.policy,
      ledger: meta.ledger,
    };
  }
}
