import * as React from "react";
import { cn } from "../../lib/utils";

function Empty({ className, children, ...props }) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "flex flex-col items-center justify-center gap-2 p-8 text-center",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function EmptyHeader({ className, ...props }) {
  return (
    <div
      data-slot="empty-header"
      className={cn("flex flex-col items-center gap-2", className)}
      {...props}
    />
  );
}

function EmptyMedia({ className, variant = "icon", children, ...props }) {
  return (
    <div
      data-slot="empty-media"
      className={cn(
        "flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground",
        variant === "icon" && "[&_svg]:size-5",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function EmptyTitle({ className, ...props }) {
  return (
    <p
      data-slot="empty-title"
      className={cn("text-sm font-semibold", className)}
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }) {
  return (
    <p
      data-slot="empty-description"
      className={cn("max-w-xs text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
};
