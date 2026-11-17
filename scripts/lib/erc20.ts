/**
 * cosmos/evm x/erc20 MsgConvertCoin: turn a bank coin of an ERC-20 token pair
 * (denom "erc20:0x…") back into the ERC-20 balance of `receiver` (0x). It is a
 * Native-lane message, so it needs a hybrid signature and no EVM window.
 *
 * The SDK 0.14.0 registry does not include it; this registers the message with
 * the SDK's own registry. Proto (cosmos/evm erc20/v1 tx.proto):
 *   message MsgConvertCoin { cosmos.base.v1beta1.Coin coin = 1; string receiver = 2; string sender = 3; }
 */
import type { EncodeObject, GeneratedType } from "@cosmjs/proto-signing";
import { BinaryReader, BinaryWriter } from "cosmjs-types/binary";
import { Coin } from "cosmjs-types/cosmos/base/v1beta1/coin";
import { qorechainRegistry } from "@qorechain/sdk";

export const MSG_CONVERT_COIN = "/cosmos.evm.erc20.v1.MsgConvertCoin";

interface MsgConvertCoin {
  coin?: Coin;
  receiver: string;
  sender: string;
}

const MsgConvertCoinType = {
  encode(m: MsgConvertCoin, w: BinaryWriter = BinaryWriter.create()): BinaryWriter {
    if (m.coin) Coin.encode(m.coin, w.uint32(10).fork()).ldelim();
    if (m.receiver) w.uint32(18).string(m.receiver);
    if (m.sender) w.uint32(26).string(m.sender);
    return w;
  },
  decode(input: BinaryReader | Uint8Array, length?: number): MsgConvertCoin {
    const r = input instanceof BinaryReader ? input : new BinaryReader(input);
    const end = length === undefined ? r.len : r.pos + length;
    const m: MsgConvertCoin = { receiver: "", sender: "" };
    while (r.pos < end) {
      const tag = r.uint32();
      switch (tag >>> 3) {
        case 1: m.coin = Coin.decode(r, r.uint32()); break;
        case 2: m.receiver = r.string(); break;
        case 3: m.sender = r.string(); break;
        default: r.skipType(tag & 7);
      }
    }
    return m;
  },
  fromPartial(o: Partial<MsgConvertCoin>): MsgConvertCoin {
    return { coin: o.coin ? Coin.fromPartial(o.coin) : undefined, receiver: o.receiver ?? "", sender: o.sender ?? "" } as MsgConvertCoin;
  },
};

export const vigilRegistry = () => qorechainRegistry([[MSG_CONVERT_COIN, MsgConvertCoinType as unknown as GeneratedType]]);

export function convertCoinMsg(sender: string, receiverEvm: string, denom: string, amount: string): EncodeObject {
  return { typeUrl: MSG_CONVERT_COIN, value: { coin: { denom, amount }, receiver: receiverEvm, sender } };
}
