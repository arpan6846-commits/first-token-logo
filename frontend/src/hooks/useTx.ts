import { useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address } from "viem";

export type TxState =
  | { status: "idle" }
  | { status: "simulating"; label: string }
  | { status: "signing"; label: string }
  | { status: "pending"; label: string; hash: `0x${string}` }
  | { status: "confirmed"; label: string; hash: `0x${string}`; block: bigint }
  | { status: "failed"; label: string; error: string; hash?: `0x${string}` };

export interface TxRequest {
  label: string;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: unknown[];
}

function explain(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ? `Reverted: ${revert.data.errorName}` : revert.shortMessage;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sends a transaction and reports its true on-chain status. A transaction is shown as successful only
 * after its receipt is mined with status "success"; nothing is assumed or simulated as a result.
 * The pre-flight simulation exists only to surface revert reasons before the user signs.
 */
export function useTx() {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { address: account } = useAccount();
  const client = usePublicClient();
  const { data: wallet } = useWalletClient();
  const queryClient = useQueryClient();

  async function send(req: TxRequest): Promise<boolean> {
    if (!client || !wallet || !account) {
      setState({ status: "failed", label: req.label, error: "Connect a wallet first" });
      return false;
    }
    let hash: `0x${string}` | undefined;
    try {
      setState({ status: "simulating", label: req.label });
      const { request } = await client.simulateContract({ ...req, args: req.args ?? [], account });
      setState({ status: "signing", label: req.label });
      hash = await wallet.writeContract(request);
      setState({ status: "pending", label: req.label, hash });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted on-chain");
      setState({ status: "confirmed", label: req.label, hash, block: receipt.blockNumber });
      await queryClient.invalidateQueries();
      return true;
    } catch (err) {
      setState({ status: "failed", label: req.label, error: explain(err), hash });
      return false;
    }
  }

  return { state, send, reset: () => setState({ status: "idle" }) };
}
