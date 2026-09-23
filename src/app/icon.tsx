import { ImageResponse } from "next/og";

import { brand } from "@/lib/brand";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

/** Favicon: the temporary "SMS" monogram (decision A18). */
export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: brand.primaryHex,
        color: "#ffffff",
        borderRadius: 14,
        fontSize: 22,
        fontWeight: 700,
        letterSpacing: 1,
      }}
    >
      SMS
    </div>,
    size,
  );
}
