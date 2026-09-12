import { X } from "lucide-react";
import { Button, Heading } from "react-aria-components";

export function LibraryDialogHeading({
  title,
  close,
}: {
  title: string;
  close: () => void;
}) {
  return (
    <div className="dialog-heading">
      <div>
        <p className="dialog-eyebrow">合谱 · Same Page</p>
        <Heading slot="title">{title}</Heading>
      </div>
      <Button className="icon-button" aria-label="关闭" onPress={close}>
        <X size={20} aria-hidden="true" />
      </Button>
    </div>
  );
}
