import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export async function brandLogoData() {
  const bytes = await readFile(join(process.cwd(), "public/brand/imtoken-fans.png"));
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

// Frame the supplied brand mark; no generated lettering or external font is needed.
export async function brandIcon(size: number) {
  const logo = await brandLogoData();
  const scale = size / 40;
  return new ImageResponse(
    <div style={{ display: "flex", position: "relative", width: size, height: size, background: "white", overflow: "hidden" }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders image data directly. */}
      <img src={logo} alt="" width={238 * scale} height={56 * scale} style={{ position: "absolute", left: -22 * scale, top: -8 * scale, maxWidth: "none" }} />
    </div>,
    { width: size, height: size },
  );
}
