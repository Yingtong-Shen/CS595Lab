use dep::merkle_trees::compute_merkle_root;
use dep::std::hash::pedersen_hash;

fn main(
    id: Field,
    r: Field,
    oldPath: [Field; 8],

    oldRoot: pub Field,
    newRoot: pub Field,
    commitment: pub Field,
    index: pub Field,
) {
    let computed_commitment = pedersen_hash([id, r]);
    assert(computed_commitment == commitment);

    let empty_leaf: Field = 0;

    let computed_old_root = compute_merkle_root(empty_leaf, index, oldPath);
    assert(computed_old_root == oldRoot);

    let computed_new_root = compute_merkle_root(commitment, index, oldPath);
    assert(computed_new_root == newRoot);
}