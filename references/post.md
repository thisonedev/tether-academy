New week, new Tether Academy update. This one's the foundation we kept deferring.

The headline is pairing. You can now run a lesson's code on a remote device: another Mac, a Mac mini, a Linux box, your friend's laptop. Web, mobile, and Windows peers are not there yet, but they're next. The path I had to take to make that work without giving away the keys was longer than I'd like to admit. Here's what landed and why each piece matters.

### Pairing runs code on remote devices, securely

The threat model I started with: a peer sends code that runs on your machine, and you have no idea what it does. So before any of this was worth shipping, every layer that touches that code path needed to be honest about what it can and cannot contain.

Network access for executed code defaults to none. Not "prompts you then honors it," it really doesn't get any. That is enforced by the sandbox profile itself, not just a UI checkbox. If a lesson asks the snippet to `fetch("https://...")`, the socket call returns nothing. There is no opt-out path baked into the surface; the lesson has to mount a capability through the grant system if it wants a network. Today nothing does.

Filesystem is also defaulted closed. Writes only land in the lesson's working directory; reads are bounded to the same. Anything outside that is a permission grant, scoped per-lesson, time-bounded.

The fail-closed pattern repeats whenever identity can fall back to weaker on-disk encryption instead of the OS keychain. If the keychain call fails, the app does not silently continue with a derived key on disk. It stops, tells you, and refuses to pair. That's the same shape as the network and filesystem defaults: when the secure path is unavailable, the app does not pretend the secure path worked.

The sandbox itself is OS-level. On macOS that's sandbox-exec with a SBPL profile written by the host. The profile is the source of truth, not a UI string the user clicked through. Code that violates the profile is killed by the kernel, not by our process. That's the only way the "default deny" claim means anything.

Two rounds of security patches landed this update. Both were the kind of bug you only find by reading your own code as if you were the adversary: a capability that leaked across lessons, an allowlist entry too broad, a path canonicalization that didn't. The pattern was the same in each case. Find, write a regression test that would have caught it, fix the root cause, verify the test fails without the fix.

### Identity is real now, not a mock

The previous version used a fake identity layer that lived entirely in app storage. That was fine for the first prototype and now it had to go.

The new identity layer is the same shape Keet uses: public-key-based, with the device key derived deterministically from a secret stored in the OS keychain when available. There are some small improvements on top. The on-disk fallback (when the keychain is unavailable, which happens in some headless and CI environments) is encrypted with a key that's stored separately, and the on-screen copy button only ever shows you one identity, the device key, because that's the only one a peer needs.

If the keychain is unavailable, the app does not pretend the keychain is available. It tells you. Pairing from that state is restricted: you can be paired with, but you can't initiate a new pairing until you move the secret somewhere it can be retrieved. That last bit is the fail-closed rule above, applied specifically to identity.

### Architecture got stronger where it needed to

The pairing path runs through a transport layer (already merged earlier) plus an exec channel that streams chunks of stdout, stderr, and progress events. The host owns the lifecycle. The peer signs the request, the host verifies it, and a clean cancel from the peer side does the right thing on the host side. The runner, the sandbox, and the SDK worker are all torn down in order. The order matters. Get it wrong and you leak processes. We wrote the test for it.

The pairing UI lives in the Settings tab under "My devices." It shows what's currently paired, the device's public key, and a Remove button. Pairing is one-time-per-device; reconnect is automatic once paired.

### Monaco editor

The lesson editor is now Monaco, the same editor VS Code uses. That is, by itself, a small thing: a code editor with syntax coloring, brackets, find/replace, multi-cursor. The reason it matters is what comes next. Monaco has the same model API VS Code has. Every collaboration feature VS Code has, we can build on the same surface, with the same shape. The first step towards live collaboration is having the same editor as the rest of the ecosystem, and that's done.

### Lesson search

You can now search across lessons within a course. It's a simple fuzzy match in the title plus body. Nothing fancy, nothing server-side, nothing rate-limited. It was one of those features that should have been there from the start, and once it landed, the time-to-anything went down enough that I stopped complaining about navigation.

### What did not change, and why

This is the part that's harder to write about, because it's the absence of decisions that ship. The lesson format is still MDX. The execution model is still the same: type code, hit run, watch the output. The SDK is still the only thing the lesson talks to. I did not change these because changing them would have meant re-writing every lesson, and that's not a productive use of this update's time.

The lesson content did get smaller, in places. Voice assistant lessons used to emit "Transcription failed: Model was unloaded" half a dozen times every time you stopped them, plus an "SDK is shutting down" line and a Turn Failed stack. Those were the SDK teardown noise showing through to the lesson output panel. A real fix needed three things: the lesson consumer has to know how to filter teardown errors, the host has to filter them too as a last line of defense, and the consumer has to actually break out of its async loops when the user clicks Stop. All three are in this update, and all three are tested.

### Closing

This is by far the most interesting project I've ever worked on. It quickly turns into a full p2p interactive online academy, which is something that doesn't even exist yet.

The foundational work takes time, and it has to be done the right way from the very beginning. After a few more iterations, you'll see an acceleration of new features and some interesting concepts that can only be built via p2p.

Hope you enjoy this one.

Cheers