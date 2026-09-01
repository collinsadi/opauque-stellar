import { describe, expect, it } from "vitest";
import {
  encodeBytesNScVal,
  encodeMapScVal,
  encodeVecScVal,
} from "../programs";

function xdrHex(value: { toXDR(format: "hex"): string }): string {
  return value.toXDR("hex");
}

describe("program ScVal encoders", () => {
  it("preserves the BytesN wire representation", () => {
    expect(xdrHex(encodeBytesNScVal(Uint8Array.from([0, 1, 2, 253, 254, 255])))).toMatchSnapshot();
  });

  it("preserves nested Vec values", () => {
    expect(
      xdrHex(
        encodeVecScVal([
          Uint8Array.from([0x10, 0x20]),
          [true, 7],
          "opaque",
        ]),
      ),
    ).toMatchSnapshot();
  });

  it("preserves Map key ordering and nested values", () => {
    expect(
      xdrHex(
        encodeMapScVal({
          bytes: Uint8Array.from([0xaa, 0xbb]),
          enabled: true,
          count: 42,
        }),
      ),
    ).toMatchSnapshot();
  });
});
