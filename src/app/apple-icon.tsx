import { ImageResponse } from "next/og";

import { brand } from "@/lib/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon for phones and tablets: the temporary "SMS" monogram. */
export default function AppleIcon() {
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
        fontSize: 60,
        fontWeight: 700,
        letterSpacing: 3,
      }}
    >
      SMS
    </div>,
    size,
  );
}
