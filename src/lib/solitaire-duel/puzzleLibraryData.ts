// src/lib/solitaire-duel/puzzleLibraryData.ts
//
// THE CURATED STRATEGIC PUZZLE LIBRARY — generated from verified winning lines.
//
// Every entry is a mid-game position taken from a deal whose winning line the
// engine proved and replayed (solveDealLine), plus a slice of that line that
// reaches a declared objective. Each one passed these quality gates:
//
//   * the objective is NOT true at the start, nor after all but the last move;
//   * at least four legal moves exist and at least two are productive;
//   * the position offers real alternatives: two or more productive distractors,
//     or the solution deliberately delays the greediest legal move;
//   * the path makes measurable progress (a reveal, a foundation gain, or a
//     freed column);
//   * stock puzzles only count when a waste card is played AFTER a draw;
//   * no deal contributes more than two puzzles, so the library is not one
//     layout re-skinned.
//
// The start position is encoded (see decodePuzzleStart in puzzleLibrary.ts)
// so this file stays data-only: no engine code runs at import time.

export const PUZZLE_LIBRARY_DATA = [
  {
    "id": "library:v1:tableau-18-194",
    "category": "tableau",
    "seed": 18,
    "startPly": 194,
    "start": "c13,d12,s11,d10,c9,d8,s7,h6/s13,h12,c11/h13,s12,h11,s10/s3/~s2,h9/~c6,~h5,~h2,~s5,c12,d11,c10,d9,c8,d7,s6,d5,s4,h3/~h10,~c5,~h7,~d3,~d2,c7,d6|s8,d4,s9,h4|h8,d13|1,1,1,4|194",
    "solution": [
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 4,
        "card": {
          "suit": "hearts",
          "rank": 9
        },
        "toColumn": 2
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 4,
        "card": {
          "suit": "spades",
          "rank": 2
        },
        "suit": "spades"
      }
    ],
    "objective": {
      "kind": "all",
      "objectives": [
        {
          "kind": "reveal-cards",
          "count": 1
        },
        {
          "kind": "open-column",
          "column": 4
        }
      ]
    },
    "provenance": {
      "branching": 5,
      "productive": 2,
      "distractors": 1,
      "delayed": false,
      "reveals": 1,
      "gain": 1,
      "draws": 0,
      "stockPasses": 0,
      "opened": 4,
      "faceDown": 10,
      "foundations": 7,
      "score": 30,
      "band": 1
    }
  },
  {
    "id": "library:v1:foundation-0-133",
    "category": "foundation",
    "seed": 0,
    "startPly": 133,
    "start": "c5/~c12,d13/~s2,c13,h12,s11,h10,c9,h8/~d6,~h11,s7/~s13,~d10,~d9,~h6,s4/~h5,~d8,~s6,~d12,d7,c6/~h4,~c7,~s9,c11|s3,s10,c8,c10,h7,h9,c4|s12,s8,h13,s5,d11|1,3,5,3|133",
    "solution": [
      {
        "kind": "draw"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 0,
        "card": {
          "suit": "clubs",
          "rank": 5
        },
        "suit": "clubs"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 14
    },
    "provenance": {
      "branching": 5,
      "productive": 2,
      "distractors": 1,
      "delayed": true,
      "reveals": 0,
      "gain": 2,
      "draws": 1,
      "stockPasses": 0,
      "opened": 0,
      "faceDown": 15,
      "foundations": 12,
      "score": 48,
      "band": 2
    }
  },
  {
    "id": "library:v1:stock-39-224",
    "category": "stock",
    "seed": 39,
    "startPly": 224,
    "start": "d10/d13,s12,h11,s10,d9,s8/~h3,s7,h6,s5,h4/h13,c12,d11/~h12,h7,s6,h5//~c10,d12,c11,h10,s9||s13,d8,h8,s11,h9,c13|4,2,7,9|224",
    "solution": [
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "diamonds"
      }
    ],
    "objective": {
      "kind": "place-card",
      "card": {
        "suit": "diamonds",
        "rank": 8
      },
      "destination": {
        "kind": "foundation",
        "suit": "diamonds"
      }
    },
    "provenance": {
      "branching": 10,
      "productive": 3,
      "distractors": 2,
      "delayed": true,
      "reveals": 0,
      "gain": 1,
      "draws": 3,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 3,
      "foundations": 22,
      "score": 64,
      "band": 3
    }
  },
  {
    "id": "library:v1:tableau-1-210",
    "category": "tableau",
    "seed": 1,
    "startPly": 210,
    "start": "h13,s12/s13,h12,c11/s11/c12,d11,s10,d9,s8,d7,s6,d5/d10,s9,d8,s7,d6,s5,d4//~d2,~c7,d13|d12,c9|c10,c8,d3,c13|4,11,1,6|210",
    "solution": [
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 6,
        "card": {
          "suit": "diamonds",
          "rank": 13
        },
        "toColumn": 5
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "clubs",
          "rank": 7
        },
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "diamonds",
          "rank": 2
        },
        "suit": "diamonds"
      }
    ],
    "objective": {
      "kind": "all",
      "objectives": [
        {
          "kind": "reveal-cards",
          "count": 2
        },
        {
          "kind": "open-column",
          "column": 6
        }
      ]
    },
    "provenance": {
      "branching": 12,
      "productive": 6,
      "distractors": 5,
      "delayed": true,
      "reveals": 2,
      "gain": 2,
      "draws": 0,
      "stockPasses": 0,
      "opened": 6,
      "faceDown": 2,
      "foundations": 22,
      "score": 80,
      "band": 4
    }
  },
  {
    "id": "library:v1:tableau-44-66",
    "category": "tableau",
    "seed": 44,
    "startPly": 66,
    "start": "c3/~s13,s2/~s4,~d10,d2/~h7,~d12,~c8,d4/~d8,~c10,~h8,~s8,d9/~h10,~d11,~h6,~s7,~c12,c11/~s6,~h1,~h13,~c7,~c9,~c13,s10|s3,d3,s11,h3,c6,h5,h9,h2|c5,s9,s5,d5,h11,h12,h4,d7,s12,d13,c4,d6,c2|1,0,1,1|66",
    "solution": [
      {
        "kind": "waste-to-foundation",
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 0,
        "card": {
          "suit": "clubs",
          "rank": 3
        },
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 1,
        "card": {
          "suit": "spades",
          "rank": 2
        },
        "suit": "spades"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 2,
        "card": {
          "suit": "diamonds",
          "rank": 2
        },
        "suit": "diamonds"
      }
    ],
    "objective": {
      "kind": "all",
      "objectives": [
        {
          "kind": "reveal-cards",
          "count": 2
        },
        {
          "kind": "open-column",
          "column": 0
        }
      ]
    },
    "provenance": {
      "branching": 10,
      "productive": 7,
      "distractors": 6,
      "delayed": true,
      "reveals": 2,
      "gain": 4,
      "draws": 0,
      "stockPasses": 0,
      "opened": 0,
      "faceDown": 21,
      "foundations": 3,
      "score": 90,
      "band": 5
    }
  },
  {
    "id": "library:v1:endgame-0-169",
    "category": "endgame",
    "seed": 0,
    "startPly": 169,
    "start": "c13,h12,s11,h10,c9,h8,s7,h6/~c12,d13//~d6,h11,s10,d9,c8,d7/s13,d12,c11,d10/~h5,d8/~h4,~c7,s9||s12,s8,h13,d11,h9,h7,c10|6,3,5,6|169",
    "solution": [
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 6,
        "card": {
          "suit": "spades",
          "rank": 9
        },
        "toColumn": 4
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "clubs",
          "rank": 7
        },
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "hearts",
          "rank": 4
        },
        "suit": "hearts"
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 11,
      "productive": 4,
      "distractors": 3,
      "delayed": true,
      "reveals": 2,
      "gain": 2,
      "draws": 0,
      "stockPasses": 0,
      "opened": 6,
      "faceDown": 5,
      "foundations": 20,
      "score": 80,
      "band": 4
    }
  },
  {
    "id": "library:v1:stock-4-147",
    "category": "stock",
    "seed": 4,
    "startPly": 147,
    "start": "h13,s12,h11,s10,d9,s8,d7,c6,d5,c4/c13,d12,c11,d10,s9/~h7,d8/~d11,~h9,~s13,h6,c5,d4,s3/~c12,~c7,~d13,~d3,h12,s11,h10,c9,h8/~s6,s7/c8||c10,h4,s5,s4,h5,d6|2,3,2,3|147",
    "solution": [
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "hearts"
      }
    ],
    "objective": {
      "kind": "place-card",
      "card": {
        "suit": "hearts",
        "rank": 4
      },
      "destination": {
        "kind": "foundation",
        "suit": "hearts"
      }
    },
    "provenance": {
      "branching": 12,
      "productive": 8,
      "distractors": 7,
      "delayed": true,
      "reveals": 0,
      "gain": 1,
      "draws": 3,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 9,
      "foundations": 10,
      "score": 80,
      "band": 4
    }
  },
  {
    "id": "library:v1:sequence-2-210",
    "category": "sequence",
    "seed": 2,
    "startPly": 210,
    "start": "c13,d12,c11,h10,c9,d8/h13,c12,d11,c10,d9,c8,h7/~d6,h8,c7,h6,c5,d4/d13,s12,h11,s10/h9,s8,d7,c6,d5/~d10,d2/~s11,d3|s13,h12|s9|7,5,1,4|210",
    "solution": [
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "diamonds",
          "rank": 2
        },
        "suit": "diamonds"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "diamonds",
          "rank": 3
        },
        "suit": "diamonds"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 2,
        "card": {
          "suit": "diamonds",
          "rank": 4
        },
        "suit": "diamonds"
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 8,
      "productive": 3,
      "distractors": 2,
      "delayed": false,
      "reveals": 2,
      "gain": 3,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 3,
      "foundations": 17,
      "score": 48,
      "band": 2
    }
  },
  {
    "id": "library:v1:stock-19-208",
    "category": "stock",
    "seed": 19,
    "startPly": 208,
    "start": "h13,s12,d11,s10,d9,s8,h7,s6,h5,s4/c10/s11,h10,c9/d13,c12/~d7,~h6,s13//~h8,~d8,~c7,c11,d10,s9||h4,d12,h11,s5,c8,h9,c13,h12,s7,s3|2,3,6,6|208",
    "solution": [
      {
        "kind": "waste-to-foundation",
        "suit": "spades"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "hearts"
      }
    ],
    "objective": {
      "kind": "place-card",
      "card": {
        "suit": "hearts",
        "rank": 4
      },
      "destination": {
        "kind": "foundation",
        "suit": "hearts"
      }
    },
    "provenance": {
      "branching": 8,
      "productive": 3,
      "distractors": 2,
      "delayed": false,
      "reveals": 0,
      "gain": 2,
      "draws": 2,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 5,
      "foundations": 17,
      "score": 48,
      "band": 2
    }
  },
  {
    "id": "library:v1:endgame-13-194",
    "category": "endgame",
    "seed": 13,
    "startPly": 194,
    "start": "s13,d12,s11,h10,c9,h8,c7,h6/h5,c4/c13,h12/c3/~h13,c12,d11,c10,d9,c8,h7,c6/~d8,~d7,~c11,~c2,c5/d13,s12,h11|d10,h9||10,4,6,1|194",
    "solution": [
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 5,
        "card": {
          "suit": "clubs",
          "rank": 5
        },
        "toColumn": 0
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "clubs",
          "rank": 2
        },
        "suit": "clubs"
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 7,
      "productive": 3,
      "distractors": 2,
      "delayed": false,
      "reveals": 2,
      "gain": 1,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 5,
      "foundations": 21,
      "score": 48,
      "band": 2
    }
  },
  {
    "id": "library:v1:foundation-23-115",
    "category": "foundation",
    "seed": 23,
    "startPly": 115,
    "start": "s8/~d10,c6,d5,c4/~c10,~s10,d9,c8/s13/d8,c7/~h6,~h1,~h10,~h7,~h12,h4,c3/~h8,~s12,~c2,~c5,~c13,~d7,s6,h5|h13,s7,d12,h9,c9,c11,d13,c12,s9|d6,h2,h3,s11,h11,d11,d4|5,0,3,1|115",
    "solution": [
      {
        "kind": "waste-to-foundation",
        "suit": "diamonds"
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 1,
        "card": {
          "suit": "clubs",
          "rank": 4
        },
        "toColumn": 6
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 1,
        "card": {
          "suit": "diamonds",
          "rank": 5
        },
        "suit": "diamonds"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 11
    },
    "provenance": {
      "branching": 4,
      "productive": 2,
      "distractors": 1,
      "delayed": false,
      "reveals": 0,
      "gain": 2,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 14,
      "foundations": 9,
      "score": 30,
      "band": 1
    }
  },
  {
    "id": "library:v1:sequence-32-132",
    "category": "sequence",
    "seed": 32,
    "startPly": 132,
    "start": "c5//h13,s12,d11,c10,d9,c8,h7/~c12,~c3,~c6,s8,d7,s6,d5,s4,h3,c2/~d4,c13,h12,s11,h10,c9,h8,c7/~h1,~d13,~h4,~d8,~c1,s3,h2/~h6,~h5,~h11,~d6,~d3,s7|d10,s10,s9,s5,c11,d12|s13,c4,h9|2,0,2,0|132",
    "solution": [
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 4,
        "card": {
          "suit": "clubs",
          "rank": 13
        },
        "toColumn": 1
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 5,
        "card": {
          "suit": "spades",
          "rank": 3
        },
        "toColumn": 4
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 4,
      "productive": 2,
      "distractors": 1,
      "delayed": false,
      "reveals": 2,
      "gain": 0,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 14,
      "foundations": 4,
      "score": 30,
      "band": 1
    }
  },
  {
    "id": "library:v1:endgame-3-211",
    "category": "endgame",
    "seed": 3,
    "startPly": 211,
    "start": "d13,c12,d11,s10,h9,s8,h7,c6/h13,s12,h11,c10,d9,c8,d7,s6/c4//d12,c11,h10,c9,d8,s7,h6/s13,h12,s11,d10,s9,h8,c7,d6,c5/c13|||5,5,5,3|211",
    "solution": [
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 4,
        "card": {
          "suit": "hearts",
          "rank": 6
        },
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 1,
        "card": {
          "suit": "spades",
          "rank": 6
        },
        "suit": "spades"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 2,
        "card": {
          "suit": "clubs",
          "rank": 4
        },
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 4,
        "card": {
          "suit": "spades",
          "rank": 7
        },
        "suit": "spades"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "clubs",
          "rank": 5
        },
        "suit": "clubs"
      }
    ],
    "objective": {
      "kind": "place-card",
      "card": {
        "suit": "clubs",
        "rank": 5
      },
      "destination": {
        "kind": "foundation",
        "suit": "clubs"
      }
    },
    "provenance": {
      "branching": 15,
      "productive": 4,
      "distractors": 3,
      "delayed": true,
      "reveals": 0,
      "gain": 5,
      "draws": 0,
      "stockPasses": 0,
      "opened": 2,
      "faceDown": 0,
      "foundations": 18,
      "score": 86,
      "band": 5
    }
  },
  {
    "id": "library:v1:endgame-5-221",
    "category": "endgame",
    "seed": 5,
    "startPly": 221,
    "start": "c13,h12,c11,h10/d13,s12,h11,c10,d9,s8,d7,s6,h5/h13/d12,s11,d10,s9,h8,s7/~h7,~h4,d11,s10,h9/s13/h6||d8,c12|5,3,6,9|221",
    "solution": [
      {
        "kind": "waste-to-tableau",
        "toColumn": 2
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 4,
        "card": {
          "suit": "diamonds",
          "rank": 11
        },
        "toColumn": 2
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 4,
        "card": {
          "suit": "hearts",
          "rank": 4
        },
        "suit": "hearts"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 24
    },
    "provenance": {
      "branching": 11,
      "productive": 4,
      "distractors": 3,
      "delayed": false,
      "reveals": 2,
      "gain": 1,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 2,
      "foundations": 23,
      "score": 64,
      "band": 3
    }
  },
  {
    "id": "library:v1:endgame-6-197",
    "category": "endgame",
    "seed": 6,
    "startPly": 197,
    "start": "/s11,d10,c9,h8,s7,h6/s13,d12/~c11,~d13,h13,s12,h11,c10,d9,s8,h7,s6,h5//~d7,~h2,c8/~s5,~h9,h12|c13,s9,d11,h4,h10|d8,s10,c12,h3|4,1,6,7|197",
    "solution": [
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "clubs",
          "rank": 8
        },
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "hearts",
          "rank": 2
        },
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "diamonds",
          "rank": 7
        },
        "suit": "diamonds"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "hearts"
      }
    ],
    "objective": {
      "kind": "place-card",
      "card": {
        "suit": "hearts",
        "rank": 3
      },
      "destination": {
        "kind": "foundation",
        "suit": "hearts"
      }
    },
    "provenance": {
      "branching": 10,
      "productive": 6,
      "distractors": 5,
      "delayed": false,
      "reveals": 2,
      "gain": 4,
      "draws": 0,
      "stockPasses": 0,
      "opened": 5,
      "faceDown": 6,
      "foundations": 18,
      "score": 82,
      "band": 5
    }
  },
  {
    "id": "library:v1:endgame-7-241",
    "category": "endgame",
    "seed": 7,
    "startPly": 241,
    "start": "h11,c10,h9/d13,s12/h13,c12,d11,s10/c13,d12,s11,h10/c9,h8//s13,h12,c11,d10|||9,7,9,8|241",
    "solution": [
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 4,
        "card": {
          "suit": "hearts",
          "rank": 8
        },
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 4,
        "card": {
          "suit": "clubs",
          "rank": 9
        },
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "diamonds",
          "rank": 10
        },
        "suit": "diamonds"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 36
    },
    "provenance": {
      "branching": 16,
      "productive": 6,
      "distractors": 5,
      "delayed": true,
      "reveals": 0,
      "gain": 3,
      "draws": 0,
      "stockPasses": 0,
      "opened": 4,
      "faceDown": 0,
      "foundations": 33,
      "score": 82,
      "band": 5
    }
  },
  {
    "id": "library:v1:endgame-8-221",
    "category": "endgame",
    "seed": 8,
    "startPly": 221,
    "start": "c13,d12,c11,h10,s9/c9/~s8,h11/s10/h13,c12,d11,c10,h9,c8//|s13,d13,h12|s11,s12|7,8,10,7|221",
    "solution": [
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 4,
        "card": {
          "suit": "clubs",
          "rank": 8
        },
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 4,
        "card": {
          "suit": "hearts",
          "rank": 9
        },
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 1,
        "card": {
          "suit": "clubs",
          "rank": 9
        },
        "suit": "clubs"
      }
    ],
    "objective": {
      "kind": "open-column",
      "column": 1
    },
    "provenance": {
      "branching": 11,
      "productive": 3,
      "distractors": 2,
      "delayed": false,
      "reveals": 0,
      "gain": 3,
      "draws": 0,
      "stockPasses": 0,
      "opened": 1,
      "faceDown": 1,
      "foundations": 32,
      "score": 58,
      "band": 3
    }
  },
  {
    "id": "library:v1:endgame-9-242",
    "category": "endgame",
    "seed": 9,
    "startPly": 242,
    "start": "d10,c9/h13,s12,h11,c10,d9,c8,d7,s6,d5,s4/d13,c12,d11,s10,h9,s8/s13,h12/c13,d12,s11,h10/~s2,c11/s9,d8,c7,d6,s5,d4,s3||s7|1,8,3,6|242",
    "solution": [
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 5,
        "card": {
          "suit": "clubs",
          "rank": 11
        },
        "toColumn": 3
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "spades",
          "rank": 2
        },
        "suit": "spades"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "spades",
          "rank": 3
        },
        "suit": "spades"
      }
    ],
    "objective": {
      "kind": "place-card",
      "card": {
        "suit": "spades",
        "rank": 3
      },
      "destination": {
        "kind": "foundation",
        "suit": "spades"
      }
    },
    "provenance": {
      "branching": 11,
      "productive": 4,
      "distractors": 3,
      "delayed": false,
      "reveals": 1,
      "gain": 2,
      "draws": 0,
      "stockPasses": 0,
      "opened": 5,
      "faceDown": 1,
      "foundations": 18,
      "score": 62,
      "band": 3
    }
  },
  {
    "id": "library:v1:stock-34-218",
    "category": "stock",
    "seed": 34,
    "startPly": 218,
    "start": "s13,d12,c11,h10,c9,d8/d13/h13,c12,d11,c10,d9/~s2,d4,s3,d2/s5/~h12,~h11,~s11,~c8,c13/~h9,~d1,~d10,~s12,d7,s6,d5,s4,d3||d6,s7,h8,s10,s9,s8|1,7,0,7|218",
    "solution": [
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "hearts"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 16
    },
    "provenance": {
      "branching": 7,
      "productive": 3,
      "distractors": 2,
      "delayed": true,
      "reveals": 0,
      "gain": 1,
      "draws": 4,
      "stockPasses": 0,
      "opened": 0,
      "faceDown": 9,
      "foundations": 15,
      "score": 64,
      "band": 3
    }
  },
  {
    "id": "library:v1:foundation-18-213",
    "category": "foundation",
    "seed": 18,
    "startPly": 213,
    "start": "c13,d12,s11,d10,c9,d8,s7,h6,s5/s13,h12,c11/h13,s12,h11,s10,h9,s8/d13,c12,d11,c10,d9,c8,d7,s6,d5//~c6,h5/~h10,~c5,~h7,~d3,~d2,c7,d6|d4,s9|h8|4,4,1,4|213",
    "solution": [
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 0,
        "card": {
          "suit": "spades",
          "rank": 5
        },
        "suit": "spades"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "hearts",
          "rank": 5
        },
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 0,
        "card": {
          "suit": "hearts",
          "rank": 6
        },
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 3,
        "card": {
          "suit": "diamonds",
          "rank": 5
        },
        "toColumn": 5
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 16
    },
    "provenance": {
      "branching": 15,
      "productive": 3,
      "distractors": 2,
      "delayed": true,
      "reveals": 1,
      "gain": 3,
      "draws": 0,
      "stockPasses": 0,
      "opened": 0,
      "faceDown": 6,
      "foundations": 13,
      "score": 64,
      "band": 3
    }
  },
  {
    "id": "library:v1:sequence-64-224",
    "category": "sequence",
    "seed": 64,
    "startPly": 224,
    "start": "h13,c12,h11/s10,h9,s8/h6,s5/c13,h12,s11,h10,s9,h8,s7/~d12,~s13,c10/~s4,~d7,s6/~s12,~s3,~h7,~h5,~d9,~c2,c11,d10,c9,d8,c7|c3,c6|c5,c4,c8,d11,d13,s2|1,4,6,1|224",
    "solution": [
      {
        "kind": "waste-to-foundation",
        "suit": "spades"
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 4,
        "card": {
          "suit": "clubs",
          "rank": 10
        },
        "toColumn": 0
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 2,
        "card": {
          "suit": "hearts",
          "rank": 6
        },
        "toColumn": 3
      }
    ],
    "objective": {
      "kind": "all",
      "objectives": [
        {
          "kind": "reveal-cards",
          "count": 1
        },
        {
          "kind": "open-column",
          "column": 2
        }
      ]
    },
    "provenance": {
      "branching": 10,
      "productive": 6,
      "distractors": 5,
      "delayed": false,
      "reveals": 1,
      "gain": 1,
      "draws": 0,
      "stockPasses": 0,
      "opened": 1,
      "faceDown": 10,
      "foundations": 12,
      "score": 62,
      "band": 3
    }
  },
  {
    "id": "library:v1:tableau-11-179",
    "category": "tableau",
    "seed": 11,
    "startPly": 179,
    "start": "s13,h12,s11/c13,d12/~h3,~s5,d10,c9,h8,c7,h6,c5,h4/~s1,~c11,~d7,s9,d8,s7/h13,s12,h11,c10,d9,c8,h7,c6,h5,s4/~c12,~s3,~h9,~d6,~d13,s2/~d11,~h2,~s8,~c4,~c3,h10|s10,s6||0,1,5,2|179",
    "solution": [
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 6,
        "card": {
          "suit": "hearts",
          "rank": 10
        },
        "toColumn": 0
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "clubs",
          "rank": 3
        },
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "clubs",
          "rank": 4
        },
        "suit": "clubs"
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 8,
      "productive": 4,
      "distractors": 3,
      "delayed": true,
      "reveals": 3,
      "gain": 2,
      "draws": 0,
      "stockPasses": 0,
      "opened": 0,
      "faceDown": 15,
      "foundations": 8,
      "score": 64,
      "band": 3
    }
  },
  {
    "id": "library:v1:stock-20-129",
    "category": "stock",
    "seed": 20,
    "startPly": 129,
    "start": "d12,c11,h10,s9,d8,s7,d6,s5,h4,s3/~h5,d5,s4,h3/c9/s13///~s6,~d7,~c7,~d11,~d3,~h12,h13,c12,h11,c10,d9,c8||h7,d4,h2,h8,s10,d13,h6,s11,s12,h9,s8,d10,c13|2,1,2,6|129",
    "solution": [
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "hearts"
      }
    ],
    "objective": {
      "kind": "place-card",
      "card": {
        "suit": "hearts",
        "rank": 2
      },
      "destination": {
        "kind": "foundation",
        "suit": "hearts"
      }
    },
    "provenance": {
      "branching": 12,
      "productive": 7,
      "distractors": 6,
      "delayed": true,
      "reveals": 0,
      "gain": 1,
      "draws": 4,
      "stockPasses": 0,
      "opened": 0,
      "faceDown": 7,
      "foundations": 11,
      "score": 86,
      "band": 5
    }
  },
  {
    "id": "library:v1:foundation-14-199",
    "category": "foundation",
    "seed": 14,
    "startPly": 199,
    "start": "c13,h12,s11,d10/s8,h7,c6,d5,s4/c11,h10,s9,h8,c7,d6/d13,s12,d11,c10,d9,c8,d7,s6/d3/c9,d8,s7,h6,s5,d4/|c12,s13,d12,s10|h11,h9,h13,h5|3,4,2,5|199",
    "solution": [
      {
        "kind": "waste-to-foundation",
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 1,
        "card": {
          "suit": "spades",
          "rank": 4
        },
        "suit": "spades"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 4,
        "card": {
          "suit": "diamonds",
          "rank": 3
        },
        "suit": "diamonds"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "diamonds",
          "rank": 4
        },
        "suit": "diamonds"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "spades",
          "rank": 5
        },
        "suit": "spades"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 19
    },
    "provenance": {
      "branching": 14,
      "productive": 7,
      "distractors": 6,
      "delayed": true,
      "reveals": 0,
      "gain": 5,
      "draws": 0,
      "stockPasses": 0,
      "opened": 1,
      "faceDown": 0,
      "foundations": 14,
      "score": 90,
      "band": 5
    }
  },
  {
    "id": "library:v1:tableau-100-159",
    "category": "tableau",
    "seed": 100,
    "startPly": 159,
    "start": "c10,d9,s8,h7,c6,d5,s4/h12,c11,d10,s9,d8,c7,d6,c5,d4,c3//~h10,s13/~d13,~d12,c12/~s3,~s12,h13/~c4,~d11,~h8,~s5,~c8,h6|s7|s11,d7,h11,c13,h9,c9,s6,s10,h5|2,4,3,2|159",
    "solution": [
      {
        "kind": "waste-to-foundation",
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 1,
        "card": {
          "suit": "clubs",
          "rank": 3
        },
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 1,
        "card": {
          "suit": "diamonds",
          "rank": 4
        },
        "suit": "diamonds"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "hearts",
          "rank": 6
        },
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 4,
        "card": {
          "suit": "clubs",
          "rank": 12
        },
        "toColumn": 5
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 9,
      "productive": 7,
      "distractors": 6,
      "delayed": true,
      "reveals": 2,
      "gain": 4,
      "draws": 0,
      "stockPasses": 0,
      "opened": 0,
      "faceDown": 10,
      "foundations": 11,
      "score": 90,
      "band": 5
    }
  },
  {
    "id": "library:v1:endgame-60-204",
    "category": "endgame",
    "seed": 60,
    "startPly": 204,
    "start": "d13,c12,h11,c10,d9,c8,d7/c13,h12,s11,h10,s9/c11,d10,c9,d8,s7,d6/h13,s12,d11,s10/d12//~h9,~h8,s6|s8|s13|5,7,5,7|204",
    "solution": [
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 2,
        "card": {
          "suit": "diamonds",
          "rank": 6
        },
        "suit": "diamonds"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "spades",
          "rank": 6
        },
        "suit": "spades"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "hearts",
          "rank": 8
        },
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "hearts",
          "rank": 9
        },
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 0,
        "card": {
          "suit": "diamonds",
          "rank": 7
        },
        "suit": "diamonds"
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 14,
      "productive": 6,
      "distractors": 5,
      "delayed": true,
      "reveals": 2,
      "gain": 5,
      "draws": 0,
      "stockPasses": 0,
      "opened": 1,
      "faceDown": 2,
      "foundations": 24,
      "score": 100,
      "band": 5
    }
  },

  // Phase 11: measured Expert/Master additions mined from proven winning lines.,

  // Phase 11: measured Expert/Master additions mined from proven winning lines.
  {
    "id": "library:v1:sequence-46-173-foundation-milestone-5",
    "category": "sequence",
    "seed": 46,
    "startPly": 173,
    "start": "c11,d10,c9,h8,c7,h6,c5,h4,c3/h13,c12,h11,s10,d9,s8,h7/c6,h5,c4//~s7,~c2,c10/h9/~h3,~s12,~d11,c13,h12,s11,h10,s9|d12,s13,d13,c8||6,2,8,1|173",
    "solution": [
      {
        "kind": "draw"
      },
      {
        "kind": "waste-to-tableau",
        "toColumn": 5
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 6,
        "card": {
          "suit": "clubs",
          "rank": 13
        },
        "toColumn": 3
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 4,
        "card": {
          "suit": "clubs",
          "rank": 10
        },
        "toColumn": 6
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 4,
        "card": {
          "suit": "clubs",
          "rank": 2
        },
        "suit": "clubs"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 18
    },
    "provenance": {
      "branching": 11,
      "productive": 4,
      "distractors": 3,
      "delayed": true,
      "reveals": 3,
      "gain": 1,
      "draws": 1,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 5,
      "foundations": 17,
      "score": 80,
      "band": 4
    }
  },
  {
    "id": "library:v1:foundation-12-162-foundation-milestone-4",
    "category": "foundation",
    "seed": 12,
    "startPly": 162,
    "start": "h6/~c13,d10,s9,d8,s7/h10,c9/h13,c12,d11,s10,d9/c10,h9/~h5,~c4,~s6,~c11,d12,s11/~c7,h11|s13,s12,h7,c5,c6,h8,d13,d6,h12,d7|c8,s8|5,4,5,3|162",
    "solution": [
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "diamonds"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 18
    },
    "provenance": {
      "branching": 10,
      "productive": 7,
      "distractors": 6,
      "delayed": true,
      "reveals": 0,
      "gain": 1,
      "draws": 3,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 6,
      "foundations": 17,
      "score": 80,
      "band": 4
    }
  },
  {
    "id": "library:v1:stock-1-247-foundation-milestone-4",
    "category": "stock",
    "seed": 1,
    "startPly": 247,
    "start": "h13,s12/s13////d13/|d12|c13|11,12,11,12|247",
    "solution": [
      {
        "kind": "draw"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "diamonds"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 0,
        "card": {
          "suit": "spades",
          "rank": 12
        },
        "suit": "spades"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 49
    },
    "provenance": {
      "branching": 23,
      "productive": 7,
      "distractors": 6,
      "delayed": true,
      "reveals": 0,
      "gain": 3,
      "draws": 1,
      "stockPasses": 1,
      "opened": -1,
      "faceDown": 0,
      "foundations": 46,
      "score": 80,
      "band": 4
    }
  },
  {
    "id": "library:v1:tableau-163-146-reveal-cards-5",
    "category": "tableau",
    "seed": 163,
    "startPly": 146,
    "start": "d13,c12,h11,c10,h9,c8,d7,s6/s11,h10,c9,h8,c7,h6,c5//s13,d12/~d5,~h12,s4/c11,d10/~s5,~c13,~c4,~s7,~s3,d8|d11,d9,s8,c6,s10,s12,h7,s9,d6|h13|2,5,4,3|146",
    "solution": [
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "waste-to-tableau",
        "toColumn": 5
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 6,
        "card": {
          "suit": "diamonds",
          "rank": 8
        },
        "toColumn": 5
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "spades",
          "rank": 3
        },
        "suit": "spades"
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 10,
      "productive": 4,
      "distractors": 3,
      "delayed": true,
      "reveals": 2,
      "gain": 1,
      "draws": 2,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 7,
      "foundations": 14,
      "score": 80,
      "band": 4
    }
  },
  {
    "id": "library:v1:sequence-142-141-reveal-cards-5",
    "category": "sequence",
    "seed": 142,
    "startPly": 141,
    "start": "s10,d9,s8,h7,s6//~h11,d12,s11,h10,c9,h8,c7,h6/c10/~s4,~s5,~h5,~c12,s13,h12/c8,d7/~c11,~c6,~d2,~s1,~c13,h13,s12,d11|s7,s2,s9,d4,s3,d13,d10,d6,d3|d8,d5,h9|0,4,1,5|141",
    "solution": [
      {
        "kind": "waste-to-tableau",
        "toColumn": 3
      },
      {
        "kind": "waste-to-tableau",
        "toColumn": 0
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 4,
        "card": {
          "suit": "spades",
          "rank": 13
        },
        "toColumn": 1
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 0,
        "card": {
          "suit": "spades",
          "rank": 10
        },
        "toColumn": 6
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 6,
        "card": {
          "suit": "hearts",
          "rank": 13
        },
        "toColumn": 0
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 10,
      "productive": 6,
      "distractors": 5,
      "delayed": true,
      "reveals": 2,
      "gain": 0,
      "draws": 0,
      "stockPasses": 0,
      "opened": 0,
      "faceDown": 10,
      "foundations": 10,
      "score": 92,
      "band": 5
    }
  },
  {
    "id": "library:v1:foundation-172-53-foundation-milestone-5",
    "category": "foundation",
    "seed": 172,
    "startPly": 53,
    "start": "h2/~d13,d5/~s4,~s8,s6/~d10,~s7,~c6,d4/~h12,~c7,~s11,~h4,c3/~d7,~c2,~d9,~d11,~s12,h3/~d1,~d12,~d6,~c13,~s5,~h6,s2|c11,c8,h5,h9,d2,h8,s10,h7,c10,d3,h13,c5,c9,d8,s13,c12,h10,s9,h11,c4|s3,s1|0,1,0,1|53",
    "solution": [
      {
        "kind": "waste-to-foundation",
        "suit": "spades"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 0,
        "card": {
          "suit": "hearts",
          "rank": 2
        },
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "hearts",
          "rank": 3
        },
        "suit": "hearts"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "spades",
          "rank": 2
        },
        "suit": "spades"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "spades"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 7
    },
    "provenance": {
      "branching": 10,
      "productive": 8,
      "distractors": 7,
      "delayed": true,
      "reveals": 2,
      "gain": 5,
      "draws": 0,
      "stockPasses": 0,
      "opened": 0,
      "faceDown": 21,
      "foundations": 2,
      "score": 96,
      "band": 5
    }
  },
  {
    "id": "library:v1:stock-125-169-reveal-cards-5",
    "category": "stock",
    "seed": 125,
    "startPly": 169,
    "start": "s13,h12,c11,d10,c9/s11,h10,s9,d8,s7/~d12,d13,s12,h11///~s6,~s10,~c4,~h13,h9,c8,d7,c6/|c10,d9|c5,c7,s8,d11,c12,c13|5,8,6,3|169",
    "solution": [
      {
        "kind": "draw"
      },
      {
        "kind": "draw"
      },
      {
        "kind": "waste-to-tableau",
        "toColumn": 2
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 5,
        "card": {
          "suit": "hearts",
          "rank": 9
        },
        "toColumn": 2
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 5,
        "card": {
          "suit": "hearts",
          "rank": 13
        },
        "toColumn": 3
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 13,
      "productive": 7,
      "distractors": 6,
      "delayed": true,
      "reveals": 2,
      "gain": 0,
      "draws": 2,
      "stockPasses": 1,
      "opened": -1,
      "faceDown": 5,
      "foundations": 22,
      "score": 92,
      "band": 5
    }
  },

  // Phase 12: thin-tier top-up — Beginner and Intermediate positions, with
  // three more Sequence lines so the category is no longer the thinnest pool.
  {
    "id": "library:v1:sequence-50-42-reveal-cards-1",
    "category": "sequence",
    "seed": 50,
    "startPly": 42,
    "start": "c9,h8/d2//~c4,~s13,~d6,s7/~s8,~s3,~d4,~c2,s6/~c7,~h13,~d7,~s12,~h7,s5/~d8,~c12,~d1,~h10,s4|c10,d11,s11,s10,h11,c13,h12,d13,c8,c3,h9,s9,c11,d10,c5|c6,d5,d3,d9,d12|2,6,0,1|42",
    "solution": [
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 3,
        "card": {
          "suit": "spades",
          "rank": 7
        },
        "toColumn": 0
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 5,
        "card": {
          "suit": "spades",
          "rank": 5
        },
        "toColumn": 3
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 4,
      "productive": 2,
      "distractors": 1,
      "delayed": false,
      "reveals": 2,
      "gain": 0,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 16,
      "foundations": 9,
      "score": 30,
      "band": 1
    }
  },
  {
    "id": "library:v1:sequence-108-92-reveal-cards-1",
    "category": "sequence",
    "seed": 108,
    "startPly": 92,
    "start": "/~h12,s9,d8,s7,d6,s5/~d13,h5,s4,h3/h8/~d10,~h4,~s6,~c5,d2/~d1,~s12,~s1,c7/~s2,~c9,~c6,~c4,~h2,c10,h9,s8,d7|c11,d3,d5,c13,c8,s10,d4,s3,s13,s11,d11,h11,d9|h10,h6,d12,h13,c12,h7|0,1,0,3|92",
    "solution": [
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 5,
        "card": {
          "suit": "clubs",
          "rank": 7
        },
        "toColumn": 3
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "spades",
          "rank": 1
        },
        "suit": "spades"
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 4,
      "productive": 2,
      "distractors": 1,
      "delayed": false,
      "reveals": 2,
      "gain": 1,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 14,
      "foundations": 4,
      "score": 30,
      "band": 1
    }
  },
  {
    "id": "library:v1:foundation-95-107-foundation-milestone-1",
    "category": "foundation",
    "seed": 95,
    "startPly": 107,
    "start": "h13//~d7,s6,d5,c4,d3/~s9,~d4,~s5,d8/~c13,~s12,~s7,~s3,c5/~c11,~d6,~c8,s10,d9,s8/~h10,~d1,~d10,s11|c10,h8,h11,h12,s4,d13,d11,c6,d2,h7,d12,c12,s13,c7,h9|c9,h6,h5|2,4,0,3|107",
    "solution": [
      {
        "kind": "waste-to-foundation",
        "suit": "hearts"
      },
      {
        "kind": "waste-to-foundation",
        "suit": "hearts"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 11
    },
    "provenance": {
      "branching": 5,
      "productive": 2,
      "distractors": 1,
      "delayed": false,
      "reveals": 0,
      "gain": 2,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 14,
      "foundations": 9,
      "score": 26,
      "band": 1
    }
  },
  {
    "id": "library:v1:sequence-25-137-reveal-cards-2",
    "category": "sequence",
    "seed": 25,
    "startPly": 137,
    "start": "c11,d10,s9,h8,s7/~d6,s11/~h11,~h1,h7,c6/~d8,~c12,c3,h2/~h10,~s3,~h6,~c2,s12/~c13,~h5,~d11,~s8,~d9,d7/~h12,~d3,~h13,~s10,~c8,~c1,d5,s4,h3|d12,c5,s5,c4,c9,c7,d13,d4,h4,c10|s6,s13,h9|2,0,2,0|137",
    "solution": [
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 6,
        "card": {
          "suit": "diamonds",
          "rank": 5
        },
        "toColumn": 2
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "clubs",
          "rank": 1
        },
        "suit": "clubs"
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 5,
      "productive": 2,
      "distractors": 1,
      "delayed": false,
      "reveals": 2,
      "gain": 1,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 20,
      "foundations": 4,
      "score": 32,
      "band": 2
    }
  },
  {
    "id": "library:v1:tableau-52-58-reveal-cards-2",
    "category": "tableau",
    "seed": 52,
    "startPly": 58,
    "start": "s4/~d6,d12/~s7,~c9,d8/~c3,~s12,d4/~s1,~h4,~s5,d5/~h5,~s8,~c2,~d13,~h3,c8/~h10,~d9,~c6,~c13,~c11,~c5,s2|h9,h7,h8,c12,h13,h12,c7,h6,c10,d7,s11,h11,s13,s3,d10,s9,s6|s10,c4,d11|0,2,3,1|58",
    "solution": [
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 3,
        "card": {
          "suit": "diamonds",
          "rank": 4
        },
        "suit": "diamonds"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 4,
        "card": {
          "suit": "diamonds",
          "rank": 5
        },
        "suit": "diamonds"
      }
    ],
    "objective": {
      "kind": "reveal-cards",
      "count": 2
    },
    "provenance": {
      "branching": 4,
      "productive": 3,
      "distractors": 2,
      "delayed": false,
      "reveals": 2,
      "gain": 2,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 19,
      "foundations": 6,
      "score": 34,
      "band": 2
    }
  },
  {
    "id": "library:v1:foundation-22-57-foundation-milestone-2",
    "category": "foundation",
    "seed": 22,
    "startPly": 57,
    "start": "/~d6,s11/~s13,~h4,d10/~h12,~h5,~h1,c4/~d8,~c13,d5/~c5,~c6,~d3,~s3,~h7,s5/~c10,~d4,~c9,~h8,~s12,~s9,h9|s7,d12,h6,h10,s8,d13,h3,c7,s4,h11,h2,c8,d7,s6,d9,h13,d11,s10|c12,c11,c3|2,0,2,2|57",
    "solution": [
      {
        "kind": "waste-to-foundation",
        "suit": "clubs"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 3,
        "card": {
          "suit": "clubs",
          "rank": 4
        },
        "suit": "clubs"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 8
    },
    "provenance": {
      "branching": 4,
      "productive": 4,
      "distractors": 3,
      "delayed": false,
      "reveals": 1,
      "gain": 2,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 19,
      "foundations": 6,
      "score": 32,
      "band": 2
    }
  },
  {
    "id": "library:v1:tableau-84-102",
    "category": "tableau",
    "seed": 84,
    "startPly": 102,
    "start": "c6/~h13,d8/~c8,~s8,h3/~h2,~d11,~h6,s13/~s11,~c9,~h12,~d9,s6/~s9,~c7,~s3,~s10,~s5,c3/~d7,~d6,~c10,~d10,~c2,~c1,d3|s4,c11,h8,s12,h5,h9,s7,h7,h10,c5,d13,d5,h4,c12,c13,d12|h11,d4,c4,d2|2,1,1,0|102",
    "solution": [
      {
        "kind": "waste-to-foundation",
        "suit": "diamonds"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 6,
        "card": {
          "suit": "diamonds",
          "rank": 3
        },
        "suit": "diamonds"
      }
    ],
    "objective": {
      "kind": "place-card",
      "card": {
        "suit": "diamonds",
        "rank": 3
      },
      "destination": {
        "kind": "foundation",
        "suit": "diamonds"
      }
    },
    "provenance": {
      "branching": 5,
      "productive": 3,
      "distractors": 2,
      "delayed": false,
      "reveals": 1,
      "gain": 2,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 21,
      "foundations": 4,
      "score": 30,
      "band": 1
    }
  },
  {
    "id": "library:v1:sequence-110-106",
    "category": "sequence",
    "seed": 110,
    "startPly": 106,
    "start": "d7,s6,d5/h8,c7/~s3,~h9,h13/~s12,~h3,d10,c9,d8,s7/~c2,~d11,~c12,~s5,c8,h7,c6/~h1,~h5,~c4,c13,d12,c11,h10/~d4,~d6,~d13,~d1,~h6,~s4,d3|s10,c5,d9,c10,h4,s11,h12,h2,d2|c3,s8,h11,s13,s9|2,0,0,1|106",
    "solution": [
      {
        "kind": "waste-to-tableau",
        "toColumn": 5
      },
      {
        "kind": "tableau-to-tableau",
        "fromColumn": 1,
        "card": {
          "suit": "hearts",
          "rank": 8
        },
        "toColumn": 5
      }
    ],
    "objective": {
      "kind": "open-column",
      "column": 1
    },
    "provenance": {
      "branching": 5,
      "productive": 2,
      "distractors": 1,
      "delayed": false,
      "reveals": 0,
      "gain": 0,
      "draws": 0,
      "stockPasses": 0,
      "opened": 1,
      "faceDown": 17,
      "foundations": 3,
      "score": 30,
      "band": 1
    }
  },
  {
    "id": "library:v1:foundation-119-151",
    "category": "foundation",
    "seed": 119,
    "startPly": 151,
    "start": "d13/~c7,s13,h12,s11,h10/~d4,~s9,h9/~c4,~h13,~d6,s4,d3/~s6,~h6,~c12,~s8,d9/~d10,~c6,~s5,~d11,d2/~h2,~s12,~c9,~s2,~c8,~c2,h4,c3|c13,s10,d8,s3,d5,h11,s7,h8,c11|c5,d12,h3,c10,h5,d7,h7|1,1,1,1|151",
    "solution": [
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 5,
        "card": {
          "suit": "diamonds",
          "rank": 2
        },
        "suit": "diamonds"
      },
      {
        "kind": "tableau-to-foundation",
        "fromColumn": 3,
        "card": {
          "suit": "diamonds",
          "rank": 3
        },
        "suit": "diamonds"
      }
    ],
    "objective": {
      "kind": "foundation-milestone",
      "total": 6
    },
    "provenance": {
      "branching": 5,
      "productive": 3,
      "distractors": 2,
      "delayed": false,
      "reveals": 1,
      "gain": 2,
      "draws": 0,
      "stockPasses": 0,
      "opened": -1,
      "faceDown": 20,
      "foundations": 4,
      "score": 30,
      "band": 1
    }
  }
];
