#!/usr/bin/env python3

import sys
import email
import email.policy

def decode_mhtml(input_path, output_path):
    """Extract the first text/html part from an MHTML file and write it to output."""
    with open(input_path, 'rb') as f:
        msg = email.message_from_binary_file(f, policy=email.policy.default)

    # Walk through the message parts to find the first text/html
    html_content = None
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == 'text/html':
                html_content = part.get_content()
                break
    else:
        if msg.get_content_type() == 'text/html':
            html_content = msg.get_content()

    if html_content is None:
        raise ValueError("No text/html part found in the MHTML file")

    # Write to output file as UTF-8
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html_content)

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: decode-mhtml.py <input.mhtml> <output.html>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    try:
        decode_mhtml(input_path, output_path)
        print(f"Successfully decoded {input_path} to {output_path}")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
