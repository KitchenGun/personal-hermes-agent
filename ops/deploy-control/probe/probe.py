"""Nonfinancial deployment receipt probe. No network, trading, or application state."""
PROBE_VERSION = 2

def main():
    import _deploy_context as context
    # Only the anchored launcher writes the fixed release/process-specific receipt.
    context.heartbeat('healthy')
