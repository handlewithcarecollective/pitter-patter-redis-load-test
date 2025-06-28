FROM rust:1.86 AS build

# create a new empty shell project
RUN USER=root cargo new --bin client
WORKDIR /client

# copy over your manifests
COPY ./Cargo.lock ./Cargo.lock
COPY ./Cargo.toml ./Cargo.toml

# this build step will cache your dependencies
RUN cargo build --release
RUN rm src/*.rs

# copy your source tree
COPY ./src ./src

# build for release
RUN rm ./target/release/deps/client*
RUN cargo build --release

# our final base
FROM rust:1.86

# copy the build artifact from the build stage
COPY --from=build /client/target/release/client .

# set the startup command to run your binary
CMD ["./client"]
