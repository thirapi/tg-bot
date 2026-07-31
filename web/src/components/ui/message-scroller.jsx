import * as React from "react";
import { ArrowDownIcon } from "lucide-react";
import { Button } from "./button";
import { cn } from "../../lib/utils";

const MessageScrollerContext = React.createContext(null);

function MessageScroller({ children }) {
  return (
    <MessageScrollerContext.Provider value={React.useRef({})}>
      {children}
    </MessageScrollerContext.Provider>
  );
}

function MessageScrollerViewport({ className, children, ...props }) {
  const ctx = React.useContext(MessageScrollerContext);
  const [showButton, setShowButton] = React.useState(false);
  const [pinned, setPinned] = React.useState(true);

  React.useEffect(() => {
    ctx.current.showButton = showButton;
    ctx.current.pinned = pinned;
    ctx.current.setShowButton = setShowButton;
    ctx.current.setPinned = setPinned;
  }, [ctx, showButton, pinned]);

  const scrollToBottom = React.useCallback((behavior = "smooth") => {
    const el = ctx.current.viewportEl;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, [ctx]);

  const handleScroll = React.useCallback(() => {
    const el = ctx.current.viewportEl;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 80;
    ctx.current.setPinned(nearBottom);
    ctx.current.setShowButton(!nearBottom);
  }, [ctx]);

  React.useEffect(() => {
    const el = ctx.current.viewportEl;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [ctx, handleScroll]);

  return (
    <div className={cn("relative h-full overflow-hidden", className)}>
      <div
        ref={(el) => {
          ctx.current.viewportEl = el;
        }}
        data-slot="message-scroller-viewport"
        role="log"
        aria-relevant="additions"
        aria-live="polite"
        className="h-full overflow-y-auto overscroll-contain scrollbar-none"
        {...props}
      >
        {children}
      </div>
      <MessageScrollerButton
        show={showButton}
        onClick={() => scrollToBottom("smooth")}
      />
    </div>
  );
}

function MessageScrollerButton({ show, onClick }) {
  return (
    <div
      data-slot="message-scroller-button"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-3 flex justify-center transition-opacity duration-200",
        show ? "opacity-100" : "opacity-0"
      )}
    >
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Scroll to latest message"
        onClick={onClick}
        className="pointer-events-auto rounded-full shadow-lg"
      >
        <ArrowDownIcon />
      </Button>
    </div>
  );
}

function MessageScrollerContent({ className, children, ...props }) {
  const ctx = React.useContext(MessageScrollerContext);
  const contentRef = React.useRef(null);

  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      const viewportEl = ctx.current.viewportEl;
      const pinned = ctx.current.pinned;
      if (viewportEl && pinned !== false) {
        viewportEl.scrollTop = viewportEl.scrollHeight;
      }
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ctx]);

  return (
    <div
      ref={contentRef}
      data-slot="message-scroller-content"
      className={cn("flex flex-col", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export {
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerButton,
};
