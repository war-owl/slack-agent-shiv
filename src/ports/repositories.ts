export type BranchProtection =
  | {
      status: "protected";
      defaultBranch: string;
    }
  | {
      status: "unprotected";
      defaultBranch: string;
      missing: readonly string[];
    }
  | {
      status: "unprotectable";
      defaultBranch: string;
      reason: string;
    };

/** The GitHub-side boundary for one configured repository. */
export interface RepositoryProtectionProbe {
  check(repository: string): Promise<BranchProtection>;
}
