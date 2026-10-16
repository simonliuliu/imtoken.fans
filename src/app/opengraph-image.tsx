import { ImageResponse } from "next/og";
import { brandLogoData } from "@/lib/brand-image";

export const alt = "imToken Fans";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const logo = await brandLogoData();
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", background: "#f5f7fb", padding: 48 }}>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", width: "100%", height: "100%", background: "white", borderRadius: 32, border: "1px solid #e1e7ef", padding: 72 }}>
        <img src={logo} alt="" width={714} height={168} />
        <div style={{ display: "flex", marginTop: 56, gap: 16 }}>
          {["#f43b6b", "#19334a", "#c7d9ea", "#fbd9e3"].map((color) => (
            <div key={color} style={{ width: 144, height: 12, borderRadius: 6, background: color }} />
          ))}
        </div>
      </div>
    </div>,
    size,
  );
}
