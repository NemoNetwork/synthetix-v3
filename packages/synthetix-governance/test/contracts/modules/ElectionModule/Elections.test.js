const { ethers } = hre;
const assert = require('assert/strict');
const assertBn = require('@synthetixio/core-js/utils/assertions/assert-bignumber');
const assertRevert = require('@synthetixio/core-js/utils/assertions/assert-revert');
const { bootstrap } = require('@synthetixio/deployer/utils/tests');
const initializer = require('../../../helpers/initializer');
const { getTime, fastForwardTo } = require('@synthetixio/core-js/utils/hardhat/rpc');
const { daysToSeconds } = require('@synthetixio/core-js/utils/misc/dates');
const {
  ElectionPeriod,
} = require('@synthetixio/core-modules/test/contracts/modules/ElectionModule/helpers/election-helper');
const {
  simulateDebtShareData,
  simulateCrossChainDebtShareData,
  expectedDebtShare,
  expectedVotePower,
  expectedCrossChainDebtShare,
  getCrossChainMerkleTree,
} = require('./helpers/debt-share-helper');
const { findEvent } = require('@synthetixio/core-js/utils/ethers/events');

describe('SynthetixElectionModule - general elections', function () {
  const { proxyAddress } = bootstrap(initializer);

  let ElectionModule, DebtShare, CouncilToken;

  let owner;
  let user1, user2, user3, user4, user5, user6, user7, user8, user9;

  let receipt;

  let merkleTree;

  const epochData = [
    {
      index: 0,
      snapshotId: 42,
      blockNumber: 21000000,
      winners: () => [user4.address, user5.address],
    },
    {
      index: 1,
      snapshotId: 1337,
      blockNumber: 23100007,
      winners: () => [user4.address, user6.address],
    },
    {
      index: 2,
      snapshotId: 2192,
      blockNumber: 30043001,
      winners: () => [user6.address, user5.address],
    },
  ];

  before('identify signers', async () => {
    [owner, user1, user2, user3, user4, user5, user6, user7, user8, user9] =
      await ethers.getSigners();
  });

  before('identify modules', async () => {
    ElectionModule = await ethers.getContractAt(
      'contracts/modules/ElectionModule.sol:ElectionModule',
      proxyAddress()
    );
  });

  before('deploy debt shares mock', async function () {
    const factory = await ethers.getContractFactory('DebtShareMock');
    DebtShare = await factory.deploy();
  });

  describe('when the election module is initialized', function () {
    before('initialize', async function () {
      const now = await getTime(ethers.provider);
      const epochEndDate = now + daysToSeconds(90);
      const votingPeriodStartDate = epochEndDate - daysToSeconds(7);
      const nominationPeriodStartDate = votingPeriodStartDate - daysToSeconds(7);

      await ElectionModule[
        'initializeElectionModule(string,string,address[],uint8,uint64,uint64,uint64,address)'
      ](
        'Spartan Council Token',
        'SCT',
        [owner.address],
        1,
        nominationPeriodStartDate,
        votingPeriodStartDate,
        epochEndDate,
        DebtShare.address
      );
    });

    before('set next epoch seat count to 2', async function () {
      (await ElectionModule.setNextEpochSeatCount(2)).wait();
    });

    before('identify the council token', async function () {
      CouncilToken = await ethers.getContractAt(
        'CouncilToken',
        await ElectionModule.getCouncilToken()
      );
    });

    it('shows the expected NFT owners', async function () {
      assertBn.equal(await CouncilToken.balanceOf(owner.address), 1);
      assertBn.equal(await CouncilToken.balanceOf(user1.address), 0);
      assertBn.equal(await CouncilToken.balanceOf(user2.address), 0);
      assertBn.equal(await CouncilToken.balanceOf(user3.address), 0);
    });

    it('shows that the election module is initialized', async function () {
      assert.equal(await ElectionModule.isElectionModuleInitialized(), true);
    });

    it('shows that the DebtShare contract is connected', async function () {
      assert.equal(await ElectionModule.getDebtShareContract(), DebtShare.address);
    });

    epochData.forEach(function (epoch) {
      describe(`epoch ${epoch.index} with debt share snapshot ${epoch.snapshotId}`, function () {
        it(`shows that the current epoch index is ${epoch.index}`, async function () {
          assertBn.equal(await ElectionModule.getEpochIndex(), epoch.index);
        });

        it('shows that the current period is Administration', async function () {
          assertBn.equal(await ElectionModule.getCurrentPeriod(), ElectionPeriod.Administration);
        });

        describe('before a debt share snapshot is set', function () {
          describe('when trying to retrieve the current debt share snapshot id', function () {
            it('reverts', async function () {
              await assertRevert(
                ElectionModule.getDebtShareSnapshotId(),
                'DebtShareSnapshotIdNotSet'
              );
            });
          });

          describe('when trying to retrieve the current debt share of a user', function () {
            it('returns zero', async function () {
              assertBn.equal(await ElectionModule.getDebtShare(user1.address), 0);
            });
          });
        });

        describe('before a merkle root is set', function () {
          describe('when trying to retrieve the current cross chain merkle root', function () {
            it('reverts', async function () {
              await assertRevert(
                ElectionModule.getCrossChainDebtShareMerkleRoot(),
                'MerkleRootNotSet'
              );
            });
          });

          describe('when trying to retrieve the current cross chain merkle root block number', function () {
            it('reverts', async function () {
              await assertRevert(
                ElectionModule.getCrossChainDebtShareMerkleRootBlockNumber(),
                'MerkleRootNotSet'
              );
            });
          });

          describe('when trying to retrieve the current cross chain debt share of a user', function () {
            it('returns zero', async function () {
              assertBn.equal(await ElectionModule.getDeclaredCrossChainDebtShare(user1.address), 0);
            });
          });
        });

        describe('before the nomination period begins', function () {
          describe('when trying to set the debt share id', function () {
            it('reverts', async function () {
              await assertRevert(
                ElectionModule.setDebtShareSnapshotId(0),
                'NotCallableInCurrentPeriod'
              );
            });
          });

          describe('when trying to set the cross chain debt share merkle root', function () {
            it('reverts', async function () {
              await assertRevert(
                ElectionModule.setCrossChainDebtShareMerkleRoot(
                  '0x000000000000000000000000000000000000000000000000000000000000beef',
                  1337
                ),
                'NotCallableInCurrentPeriod'
              );
            });
          });
        });

        describe('when advancing to the nominations period', function () {
          before('fast forward', async function () {
            await fastForwardTo(
              await ElectionModule.getNominationPeriodStartDate(),
              ethers.provider
            );
          });

          describe('when the current epochs debt share snapshot id is set', function () {
            before('simulate debt share data', async function () {
              await simulateDebtShareData(DebtShare, [user1, user2, user3, user4, user5]);
            });

            before('set snapshot id', async function () {
              const tx = await ElectionModule.setDebtShareSnapshotId(epoch.snapshotId);
              receipt = await tx.wait();
            });

            it('emitted a DebtShareSnapshotIdSet event', async function () {
              const event = findEvent({ receipt, eventName: 'DebtShareSnapshotIdSet' });

              assert.ok(event);
              assertBn.equal(event.args.snapshotId, epoch.snapshotId);
            });

            it('shows that the snapshot id is set', async function () {
              assertBn.equal(await ElectionModule.getDebtShareSnapshotId(), epoch.snapshotId);
            });

            it('shows that users have the expected debt shares', async function () {
              assert.deepEqual(
                await ElectionModule.getDebtShare(user1.address),
                expectedDebtShare(user1.address, epoch.snapshotId)
              );
              assert.deepEqual(
                await ElectionModule.getDebtShare(user2.address),
                expectedDebtShare(user2.address, epoch.snapshotId)
              );
              assert.deepEqual(
                await ElectionModule.getDebtShare(user3.address),
                expectedDebtShare(user3.address, epoch.snapshotId)
              );
              assert.deepEqual(
                await ElectionModule.getDebtShare(user4.address),
                expectedDebtShare(user4.address, epoch.snapshotId)
              );
              assert.deepEqual(
                await ElectionModule.getDebtShare(user5.address),
                expectedDebtShare(user5.address, epoch.snapshotId)
              );
            });

            describe('when the current epochs cross chain debt share merkle proof is set', function () {
              before('simulate cross chain debt share data', async function () {
                await simulateCrossChainDebtShareData([user1, user2, user3]);
              });

              before('set the merkle root', async function () {
                merkleTree = getCrossChainMerkleTree(epoch.snapshotId);

                const tx = await ElectionModule.setCrossChainDebtShareMerkleRoot(
                  merkleTree.merkleRoot,
                  epoch.blockNumber
                );
                receipt = await tx.wait();
              });

              before('nominate', async function () {
                (await ElectionModule.connect(user4).nominate()).wait();
                (await ElectionModule.connect(user5).nominate()).wait();
                (await ElectionModule.connect(user6).nominate()).wait();
                (await ElectionModule.connect(user7).nominate()).wait();
                (await ElectionModule.connect(user8).nominate()).wait();
                (await ElectionModule.connect(user9).nominate()).wait();
              });

              it('emitted a CrossChainDebtShareMerkleRootSet event', async function () {
                const event = findEvent({ receipt, eventName: 'CrossChainDebtShareMerkleRootSet' });

                assert.ok(event);
                assertBn.equal(event.args.merkleRoot, merkleTree.merkleRoot);
                assertBn.equal(event.args.blocknumber, epoch.blockNumber);
              });

              it('shows that the merkle root is set', async function () {
                assert.equal(
                  await ElectionModule.getCrossChainDebtShareMerkleRoot(),
                  merkleTree.merkleRoot
                );
              });

              it('shows that the merkle root block number is set', async function () {
                assertBn.equal(
                  await ElectionModule.getCrossChainDebtShareMerkleRootBlockNumber(),
                  epoch.blockNumber
                );
              });

              describe('when users declare their cross chain debt shares in the wrong period', function () {
                it('reverts', async function () {
                  await assertRevert(
                    ElectionModule.declareCrossChainDebtShare(
                      user1.address,
                      expectedCrossChainDebtShare(user1.address, epoch.snapshotId),
                      merkleTree.claims[user1.address].proof
                    ),
                    'NotCallableInCurrentPeriod'
                  );
                });
              });

              describe('when advancing to the voting period', function () {
                before('fast forward', async function () {
                  await fastForwardTo(
                    await ElectionModule.getVotingPeriodStartDate(),
                    ethers.provider
                  );
                });

                it('shows that the current period is Voting', async function () {
                  assertBn.equal(await ElectionModule.getCurrentPeriod(), ElectionPeriod.Vote);
                });

                describe('when users declare their cross chain debt shares incorrectly', function () {
                  describe('when a user declares a wrong amount', function () {
                    it('reverts', async function () {
                      const { proof } = merkleTree.claims[user2.address];

                      await assertRevert(
                        ElectionModule.declareCrossChainDebtShare(
                          user2.address,
                          ethers.utils.parseEther('10000000'),
                          proof
                        ),
                        'InvalidMerkleProof'
                      );
                    });
                  });

                  describe('when a user with no entry in the tree declares an amount', function () {
                    it('reverts', async function () {
                      const { proof } = merkleTree.claims[user2.address];

                      await assertRevert(
                        ElectionModule.declareCrossChainDebtShare(
                          user4.address,
                          ethers.utils.parseEther('1000'),
                          proof
                        ),
                        'InvalidMerkleProof'
                      );
                    });
                  });

                  describe('when a user uses the wrong tree to declare', function () {
                    it('reverts', async function () {
                      const anotherTree = getCrossChainMerkleTree(666);
                      const { amount, proof } = anotherTree.claims[user2.address];

                      await assertRevert(
                        ElectionModule.declareCrossChainDebtShare(user2.address, amount, proof),
                        'InvalidMerkleProof'
                      );
                    });
                  });
                });

                describe('when users declare their cross chain debt shares correctly', function () {
                  async function declare(user) {
                    const { amount, proof } = merkleTree.claims[user.address];

                    const tx = await ElectionModule.declareCrossChainDebtShare(
                      user.address,
                      amount,
                      proof
                    );
                    receipt = await tx.wait();
                  }

                  before('declare', async function () {
                    await declare(user1);
                    await declare(user2);
                    await declare(user3);
                  });

                  it('emitted a CrossChainDebtShareDeclared event', async function () {
                    const event = findEvent({ receipt, eventName: 'CrossChainDebtShareDeclared' });

                    assert.ok(event);
                    assertBn.equal(event.args.user, user3.address);
                    assertBn.equal(
                      event.args.debtShare,
                      expectedCrossChainDebtShare(user3.address, epoch.snapshotId)
                    );
                  });

                  it('shows that users have declared their cross chain debt shares', async function () {
                    assertBn.equal(
                      await ElectionModule.getDeclaredCrossChainDebtShare(user1.address),
                      expectedCrossChainDebtShare(user1.address, epoch.snapshotId)
                    );
                    assertBn.equal(
                      await ElectionModule.getDeclaredCrossChainDebtShare(user2.address),
                      expectedCrossChainDebtShare(user2.address, epoch.snapshotId)
                    );
                    assertBn.equal(
                      await ElectionModule.getDeclaredCrossChainDebtShare(user3.address),
                      expectedCrossChainDebtShare(user3.address, epoch.snapshotId)
                    );
                  });

                  it('shows that users have the expected vote power (cross chain component is now declared)', async function () {
                    assert.deepEqual(
                      await ElectionModule.getVotePower(user1.address),
                      expectedVotePower(user1.address, epoch.snapshotId)
                    );
                    assert.deepEqual(
                      await ElectionModule.getVotePower(user2.address),
                      expectedVotePower(user2.address, epoch.snapshotId)
                    );
                    assert.deepEqual(
                      await ElectionModule.getVotePower(user3.address),
                      expectedVotePower(user3.address, epoch.snapshotId)
                    );
                  });

                  describe('when a user tries to vote for more than one candidate', function () {
                    it('reverts', async function () {
                      await assertRevert(
                        ElectionModule.connect(user1).cast([user4.address, user5.address]),
                        'TooManyCandidates'
                      );
                    });
                  });

                  describe('when users cast votes', function () {
                    let ballot1, ballot2, ballot3;

                    before('vote', async function () {
                      await ElectionModule.connect(user1).cast([user4.address]);
                      await ElectionModule.connect(user2).cast([user4.address]);
                      await ElectionModule.connect(user3).cast([user5.address]);
                      await ElectionModule.connect(user4).cast([user6.address]);
                      await ElectionModule.connect(user5).cast([user4.address]);
                    });

                    before('identify ballots', async function () {
                      ballot1 = await ElectionModule.calculateBallotId([user4.address]);
                      ballot2 = await ElectionModule.calculateBallotId([user5.address]);
                      ballot3 = await ElectionModule.calculateBallotId([user6.address]);
                    });

                    it('keeps track of which ballot each user voted on', async function () {
                      assert.equal(await ElectionModule.getBallotVoted(user1.address), ballot1);
                      assert.equal(await ElectionModule.getBallotVoted(user2.address), ballot1);
                      assert.equal(await ElectionModule.getBallotVoted(user3.address), ballot2);
                      assert.equal(await ElectionModule.getBallotVoted(user4.address), ballot3);
                      assert.equal(await ElectionModule.getBallotVoted(user5.address), ballot1);
                    });

                    it('keeps track of the candidates of each ballot', async function () {
                      assert.deepEqual(await ElectionModule.getBallotCandidates(ballot1), [
                        user4.address,
                      ]);
                      assert.deepEqual(await ElectionModule.getBallotCandidates(ballot2), [
                        user5.address,
                      ]);
                      assert.deepEqual(await ElectionModule.getBallotCandidates(ballot3), [
                        user6.address,
                      ]);
                    });

                    it('keeps track of vote power in each ballot', async function () {
                      const votesBallot1 = expectedVotePower(user1.address, epoch.snapshotId)
                        .add(expectedVotePower(user2.address, epoch.snapshotId))
                        .add(expectedVotePower(user5.address, epoch.snapshotId));
                      const votesBallot2 = expectedVotePower(user3.address, epoch.snapshotId);
                      const votesBallot3 = expectedVotePower(user4.address, epoch.snapshotId);

                      assertBn.equal(await ElectionModule.getBallotVotes(ballot1), votesBallot1);
                      assertBn.equal(await ElectionModule.getBallotVotes(ballot2), votesBallot2);
                      assertBn.equal(await ElectionModule.getBallotVotes(ballot3), votesBallot3);
                    });

                    describe('when voting ends', function () {
                      before('fast forward', async function () {
                        await fastForwardTo(
                          await ElectionModule.getEpochEndDate(),
                          ethers.provider
                        );
                      });

                      it('shows that the current period is Evaluation', async function () {
                        assertBn.equal(
                          await ElectionModule.getCurrentPeriod(),
                          ElectionPeriod.Evaluation
                        );
                      });

                      describe('when the election is evaluated', function () {
                        before('evaluate', async function () {
                          (await ElectionModule.evaluate(0)).wait();
                        });

                        it('shows that the election is evaluated', async function () {
                          assert.equal(await ElectionModule.isElectionEvaluated(), true);
                        });

                        it('shows each candidates votes', async function () {
                          const votesUser4 = expectedVotePower(user1.address, epoch.snapshotId)
                            .add(expectedVotePower(user2.address, epoch.snapshotId))
                            .add(expectedVotePower(user5.address, epoch.snapshotId));
                          const votesUser5 = expectedVotePower(user3.address, epoch.snapshotId);
                          const votesUser6 = expectedVotePower(user4.address, epoch.snapshotId);

                          assertBn.equal(
                            await ElectionModule.getCandidateVotes(user4.address),
                            votesUser4
                          );
                          assertBn.equal(
                            await ElectionModule.getCandidateVotes(user5.address),
                            votesUser5
                          );
                          assertBn.equal(
                            await ElectionModule.getCandidateVotes(user6.address),
                            votesUser6
                          );
                          assertBn.equal(await ElectionModule.getCandidateVotes(user7.address), 0);
                          assertBn.equal(await ElectionModule.getCandidateVotes(user8.address), 0);
                          assertBn.equal(await ElectionModule.getCandidateVotes(user9.address), 0);
                        });

                        it('shows the election winners', async function () {
                          assert.deepEqual(
                            await ElectionModule.getElectionWinners(),
                            epoch.winners()
                          );
                        });

                        describe('when the election is resolved', function () {
                          before('resolve', async function () {
                            (await ElectionModule.resolve()).wait();
                          });

                          it('shows the expected NFT owners', async function () {
                            const winners = epoch.winners();

                            assertBn.equal(
                              await CouncilToken.balanceOf(owner.address),
                              winners.includes(owner.address) ? 1 : 0
                            );
                            assertBn.equal(
                              await CouncilToken.balanceOf(user4.address),
                              winners.includes(user4.address) ? 1 : 0
                            );
                            assertBn.equal(
                              await CouncilToken.balanceOf(user5.address),
                              winners.includes(user5.address) ? 1 : 0
                            );
                            assertBn.equal(
                              await CouncilToken.balanceOf(user6.address),
                              winners.includes(user6.address) ? 1 : 0
                            );
                            assertBn.equal(
                              await CouncilToken.balanceOf(user7.address),
                              winners.includes(user7.address) ? 1 : 0
                            );
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});