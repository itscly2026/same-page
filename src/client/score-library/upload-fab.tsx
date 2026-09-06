import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";

export function UploadFab({ onPress, disabled = false }: { onPress: () => void; disabled?: boolean }) {
  const [visible, setVisible] = useState(true);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let previous = Math.max(0, window.scrollY);
    let distance = 0;
    const onScroll = () => {
      const current = Math.max(0, Math.min(window.scrollY, document.documentElement.scrollHeight - window.innerHeight));
      const delta = current - previous;
      previous = current;
      if (current <= 24) { distance = 0; setVisible(true); return; }
      if (Math.sign(delta) !== Math.sign(distance)) distance = 0;
      distance += delta;
      if (Math.abs(distance) >= 12) {
        // Keep a keyboard-focused upload action reachable until focus leaves it.
        setVisible(distance < 0 || document.activeElement === button.current);
        distance = 0;
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return <Button ref={button} className="upload-fab" isDisabled={disabled} aria-label={disabled ? "上传 PDF（需联网）" : "上传 PDF"} data-visible={visible} inert={!visible} onPress={onPress}><Plus size={28} aria-hidden="true" /></Button>;
}
