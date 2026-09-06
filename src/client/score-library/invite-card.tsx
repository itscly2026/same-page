import { QRCodeSVG } from "qrcode.react";
import logo from "../../../public/icon-192.png?inline";
import type { Ref } from "react";

export function InviteCard({ choirName, link, code, ref }: { choirName: string; link: string; code: string; ref?: Ref<SVGSVGElement> }) {
  const characters = Array.from(choirName);
  const lines = Array.from({ length: Math.ceil(characters.length / 14) }, (_, index) => characters.slice(index * 14, index * 14 + 14).join(""));
  const extraHeight = Math.max(0, lines.length - 1) * 28;
  return (
    <svg ref={ref} className="invite-card" xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 360 ${426 + extraHeight}`} role="img" aria-label={`${choirName}邀请二维码`}>
      <rect width="360" height={426 + extraHeight} rx="20" fill="#f8f6f0" />
      <g fill="#014653" fontFamily="system-ui, sans-serif" textAnchor="middle">
        <text x="180" y="36" fontSize="11" letterSpacing="3">合谱 · SAME PAGE</text>
        {lines.map((line, index) => <text key={index} x="180" y={76 + index * 28} fontSize="21" fontWeight="600">{line}</text>)}
      </g>
      <rect x="66" y={100 + extraHeight} width="228" height="228" rx="14" fill="white" />
      <QRCodeSVG x="76" y={110 + extraHeight} value={link} size={208} marginSize={4} level="H" imageSettings={{ src: logo, width: 32, height: 32, excavate: true }} fgColor="#014653" bgColor="#ffffff" />
      <text x="180" y={356 + extraHeight} textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="14" fill="#014653">扫码进入云盘</text>
      <text x="180" y={382 + extraHeight} textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="11" fill="#657572">或输入邀请码</text>
      <text x="180" y={406 + extraHeight} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="19" fontWeight="600" letterSpacing="3" fill="#014653">{code.slice(0, 4)}–{code.slice(4)}</text>
    </svg>
  );
}
