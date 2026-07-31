import * as React from "react";
import { cn } from "../../lib/utils";

function Message({ className, align = "start", children, ...props }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        "flex w-full gap-3",
        align === "end" && "flex-row-reverse",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function MessageAvatar({ className, children, ...props }) {
  return (
    <div
      data-slot="message-avatar"
      className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground", className)}
      {...props}
    >
      {children}
    </div>
  );
}

function MessageHeader({ className, ...props }) {
  return (
    <div
      data-slot="message-header"
      className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function MessageContent({ className, children, ...props }) {
  return (
    <div
      data-slot="message-content"
      className={cn("flex w-full flex-col gap-1", className)}
      {...props}
    >
      {children}
    </div>
  );
}

function MessageFooter({ className, ...props }) {
  return (
    <div
      data-slot="message-footer"
      className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Message,
  MessageAvatar,
  MessageHeader,
  MessageContent,
  MessageFooter,
};
