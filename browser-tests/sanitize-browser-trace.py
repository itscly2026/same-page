"""Keep an action timeline without request data, DOM, console text or input values."""
import json
import sys
import zipfile

source, destination = sys.argv[1:]
# Playwright records route.fulfill payloads even with snapshots disabled.
# An allowlist also protects future fixture additions (login, notes, etc.).
with zipfile.ZipFile(source) as raw, zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as clean:
    for name in raw.namelist():
        if name.endswith(".stacks"):
            clean.writestr(name, raw.read(name))
        elif name.endswith(".network"):
            clean.writestr(name, "")
        elif name.endswith(".trace"):
            events = []
            for line in raw.read(name).decode().splitlines():
                event = json.loads(line)
                if event["type"] == "context-options":
                    event["options"] = {key: value for key, value in event.get("options", {}).items()
                                        if key in ("viewport", "deviceScaleFactor", "isMobile", "hasTouch")}
                elif event["type"] in ("before", "after"):
                    event.pop("result", None)
                    event.pop("error", None)
                    event.pop("title", None)
                    if "params" in event:
                        # Selectors and key presses are fixture-authored; omit typed text,
                        # JS expressions, request bodies/headers and all response payloads.
                        event["params"] = {key: value for key, value in event["params"].items()
                                           if key in ("selector", "key", "state", "timeout", "button", "position")}
                else:
                    continue
                events.append(json.dumps(event))
            clean.writestr(name, "\n".join(events) + "\n")
