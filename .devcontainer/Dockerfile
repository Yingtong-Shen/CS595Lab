FROM --platform=linux/amd64 debian:trixie-slim
SHELL ["/bin/bash", "-c"]

# Install dependencies
# RUN apt update && apt install -y curl bash git tar gzip libc++-dev jq nodejs npm

RUN apt update && apt install -y curl bash git tar gzip libc++-dev jq nodejs npm libnuma1

# Install noirup (which installs nargo)
RUN curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
ENV PATH="/root/.nargo/bin:$PATH"

# Install nargo via noirup
RUN noirup -v 1.0.0-beta.13

# 2. Use the updated 'next' branch installer for bbup
RUN curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/next/barretenberg/bbup/install | bash

# 3. Add both the .bb root and the /bin subdirectory to the PATH
ENV PATH="/root/.bb:/root/.bb/bin:$PATH"

# 4. Run bbup without a version flag to auto-resolve compatibility with Nargo v1.0.0-beta.13
RUN bbup


ENTRYPOINT ["nargo"]

