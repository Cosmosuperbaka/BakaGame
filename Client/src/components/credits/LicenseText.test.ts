import { describe, expect, it } from "vitest";
import { reflowLicenseText } from "./LicenseText";

const MIT = `MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.`;

describe("reflowLicenseText", () => {
  it("把普通段落里的 80 列硬换行并成一行，段落之间的空行保留", () => {
    expect(reflowLicenseText(MIT)).toBe(`MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction.`);
  });

  it("带缩进或列表记号的块原样保留", () => {
    const apache = `   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

- first item that is long enough to look like a wrapped paragraph line here
- second item`;
    expect(reflowLicenseText(apache)).toBe(apache);
  });

  it("全是短行的块（签名、地址）不并", () => {
    const short = "Copyright 2024\nSome Author\nSome City";
    expect(reflowLicenseText(short)).toBe(short);
  });

  it("只改换行，不增删任何非空白字符", () => {
    const strip = (value: string) => value.replace(/\s+/g, "");
    expect(strip(reflowLicenseText(MIT))).toBe(strip(MIT));
  });
});
