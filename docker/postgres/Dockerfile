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
       mecab-utils \
       mecab-ipadic-utf8 \
    && apt-get purge -y --auto-remove wget gnupg lsb-release \
    && rm -rf /var/lib/apt/lists/* \
    && update-alternatives --set mecab-dictionary /var/lib/mecab/dic/ipadic-utf8

# MeCab ユーザー辞書を追加
COPY user-dict.csv /tmp/user-dict.csv
RUN /usr/lib/mecab/mecab-dict-index \
      -d /usr/share/mecab/dic/ipadic \
      -u /var/lib/mecab/dic/user.dic \
      -f utf-8 -c utf-8 \
      /tmp/user-dict.csv \
    && echo "userdic = /var/lib/mecab/dic/user.dic" >> /etc/mecabrc \
    && rm /tmp/user-dict.csv
