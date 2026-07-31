import * as React from "react";
import { cn } from "../../lib/utils";

function InputGroup({ className, children, ...props }) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        "flex w-full items-center gap-1 rounded-2xl border border-input bg-background px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function InputGroupAddon({ className, ...props }) {
  return (
    <div
      data-slot="input-group-addon"
      className={cn("flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  );
}

function InputGroupButton({ className, ...props }) {
  return <button className={cn("inline-flex shrink-0", className)} {...props} />;
}

export { InputGroup, InputGroupAddon, InputGroupButton };
