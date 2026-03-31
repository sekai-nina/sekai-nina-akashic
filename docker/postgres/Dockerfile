FROM postgres:16

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       wget \
       gnupg \
       lsb-release \
    && wget -qO- https://packages.groonga.org/debian/groonga-apt-source-latest-$(lsb_release -cs).deb -O /tmp/groonga.deb \
    && dpkg -i /tmp/groonga.deb \
    && rm /tmp/groonga.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       postgresql-16-pgdg-pgroonga \
       groonga-tokenizer-mecab \
    && apt-get purge -y --auto-remove wget gnupg lsb-release \
    && rm -rf /var/lib/apt/lists/*
