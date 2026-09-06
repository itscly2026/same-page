import { useBlocker } from "react-router-dom";
import { Button, Dialog, Modal, ModalOverlay } from "react-aria-components";

export function ReaderNavigationGuard({ editing }: { editing: boolean }) {
  const blocker = useBlocker(editing);
  return <ModalOverlay className="reader-panel-backdrop reader-leave-backdrop" isOpen={blocker.state === "blocked"}>
    <Modal className="reader-leave-dialog">
      <Dialog aria-label="请先完成编辑">
        <h2>请先完成编辑</h2>
        <p>当前编辑器仍保留你的修改。请完成或取消文字输入，处理本机保存失败，再点铅笔退出编辑。</p>
        <Button className="secondary-button" onPress={() => { if (blocker.state === "blocked") blocker.reset(); }}>返回编辑器</Button>
      </Dialog>
    </Modal>
  </ModalOverlay>;
}
